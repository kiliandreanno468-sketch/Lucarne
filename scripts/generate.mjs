// Lucarne : récupère les matchs et les cotes (API-Football), calcule les
// probabilités, demande à Claude de choisir et d’expliquer les pronos,
// puis écrit data/pronos.json et met à jour le bilan dans data/history.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import * as CONFIG from './config.mjs';

const { LEAGUES } = CONFIG;
const TIMEZONE = CONFIG.TIMEZONE ?? 'Europe/Paris';
const MODEL = CONFIG.MODEL ?? 'claude-sonnet-5-5';
const MAX_FIXTURES = CONFIG.MAX_FIXTURES ?? 22;
const REQUEST_DELAY_MS = CONFIG.REQUEST_DELAY_MS ?? 6500;
const SCORERS_REFRESH_DAYS = CONFIG.SCORERS_REFRESH_DAYS ?? 4;
const TIER_RULES = {
  safe:   { minOdds: 1.15, maxOdds: 1.65, minProb: 0.68, max: 6 },
  crazy:  { minOdds: 1.80, maxOdds: 3.60, minProb: 0.28, max: 6 },
  rich:   { minOdds: 5.00, maxOdds: 60,   minProb: 0.04, max: 6 },
  draw:   { minOdds: 2.60, maxOdds: 4.60, minProb: 0.20, max: 6 },
  sniper: { minOdds: 1.40, maxOdds: 8,    minProb: 0.22, max: 6 },
  var:    { max: 6 },
  ...CONFIG.TIER_RULES,
};

const API = 'https://v3.football.api-sports.io';
const FOOT_KEY = process.env.APIFOOTBALL_KEY;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const DELAY = Number(process.env.REQUEST_DELAY_MS ?? REQUEST_DELAY_MS);
const MODE = String(process.env.MODE || 'complet').toLowerCase();   // complet | resultats
const DATA_DIR = new URL('../data/', import.meta.url);
const DAY_MS = 864e5;

const LEAGUE_BY_ID = new Map(LEAGUES.map((l, i) => [l.id, { ...l, rank: i }]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const mean = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const median = arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------- Dates ---------- */
const dayKey = d => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dayLabel = key => {
  const s = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(key + 'T12:00:00Z'));
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const timeLabel = iso => new Intl.DateTimeFormat('fr-FR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)).replace(':', 'h');

/* ---------- API-Football ---------- */
let calls = 0;
async function football(path, params = {}) {
  if (calls > 0) await sleep(DELAY);
  calls++;
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'x-apisports-key': FOOT_KEY } });
  if (!res.ok) throw new Error(`API-Football a répondu ${res.status} sur ${path}`);
  const json = await res.json();
  const errors = json.errors && (Array.isArray(json.errors) ? json.errors : Object.values(json.errors));
  if (errors && errors.length) throw new Error(`API-Football (${path}) : ${JSON.stringify(json.errors)}`);
  return json.response ?? [];
}

/* ---------- Fichiers ---------- */
async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA_DIR), 'utf8')); } catch { return fallback; }
}
async function writeJson(name, value) {
  await writeFile(new URL(name, DATA_DIR), JSON.stringify(value, null, 1) + '\n');
}

/* ---------- Marchés ----------
   Clés : 1X2:H|D|A, DC:HD|AD|HA, OU:O|U:ligne, BTTS:Y|N, CS:2-1, SC:idJoueur (buteur) */
function settle(key, h, a, scorers) {
  const [type, x, y] = key.split(':');
  switch (type) {
    case '1X2': return x === 'H' ? h > a : x === 'D' ? h === a : a > h;
    case 'DC': return x === 'HD' ? h >= a : x === 'AD' ? a >= h : h !== a;
    case 'OU': return x === 'O' ? h + a > Number(y) : h + a < Number(y);
    case 'BTTS': return x === 'Y' ? (h > 0 && a > 0) : !(h > 0 && a > 0);
    case 'CS': { const [sh, sa] = x.split('-').map(Number); return sh === h && sa === a; }
    case 'SC': return Array.isArray(scorers) ? scorers.includes(Number(x)) : null;
    default: return false;
  }
}

function label(key, home, away) {
  const [t, x, y] = key.split(':');
  if (t === '1X2') return x === 'H' ? `${home} gagne` : x === 'A' ? `${away} gagne` : 'Match nul';
  if (t === 'DC') return x === 'HD' ? `${home} ou match nul` : x === 'AD' ? `${away} ou match nul` : `${home} ou ${away}`;
  if (t === 'OU') return `${x === 'O' ? 'Plus' : 'Moins'} de ${y.replace('.', ',')} buts`;
  if (t === 'BTTS') return x === 'Y' ? 'Les deux équipes marquent' : 'Au moins une équipe ne marque pas';
  return `Score exact ${x}`;
}

const OU_LINES = new Set(['1.5', '2.5', '3.5', '4.5']);
function collectOdds(oddsResponse) {
  const found = {};
  for (const book of oddsResponse?.[0]?.bookmakers ?? []) {
    for (const bet of book.bets ?? []) {
      const name = String(bet.name ?? '').toLowerCase();
      for (const v of bet.values ?? []) {
        const odd = num(v.odd);
        if (!(odd > 1)) continue;
        const val = String(v.value);
        let key = null;
        if (name === 'match winner') key = { Home: '1X2:H', Draw: '1X2:D', Away: '1X2:A' }[val];
        else if (name === 'double chance') key = { 'Home/Draw': 'DC:HD', 'Draw/Away': 'DC:AD', 'Home/Away': 'DC:HA' }[val];
        else if (name === 'goals over/under') {
          const m = val.match(/^(Over|Under) (\d+\.5)$/);
          if (m && OU_LINES.has(m[2])) key = `OU:${m[1][0]}:${m[2]}`;
        } else if (name === 'both teams score') key = { Yes: 'BTTS:Y', No: 'BTTS:N' }[val];
        else if (name === 'exact score') {
          const m = val.match(/^(\d+):(\d+)$/);
          if (m) key = `CS:${m[1]}-${m[2]}`;
        }
        if (key) (found[key] ||= []).push(odd);
      }
    }
  }
  const odds = {};
  for (const k in found) odds[k] = median(found[k]);   // cote médiane des bookmakers
  return odds;
}

// Cotes « buteur à tout moment », rangées par nom de joueur normalisé.
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
function collectScorerOdds(oddsResponse) {
  const found = new Map();
  for (const book of oddsResponse?.[0]?.bookmakers ?? []) {
    for (const bet of book.bets ?? []) {
      const name = String(bet.name ?? '').toLowerCase();
      if (!name.includes('anytime') || !name.includes('scorer')) continue;
      for (const v of bet.values ?? []) {
        const odd = num(v.odd), who = norm(v.value);
        if (!(odd > 1) || !who) continue;
        if (!found.has(who)) found.set(who, []);
        found.get(who).push(odd);
      }
    }
  }
  return new Map([...found].map(([k, v]) => [k, median(v)]));
}
function findScorerOdd(map, pl) {
  if (!map?.size) return null;
  const tokens = norm(pl.last || pl.name).split(' ').filter(t => t.length >= 3);
  const initial = norm(pl.first).charAt(0);
  for (const [who, odd] of map) {
    const words = who.split(' ');
    if (!tokens.some(t => words.includes(t))) continue;
    if (initial && words.length > 1 && who.charAt(0) !== initial) continue;
    return odd;
  }
  return null;
}

/* ---------- Modèle de probabilités ---------- */
function poisson(l, k) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function scoreMatrix(lh, la, max = 8) {
  const M = [];
  for (let i = 0; i <= max; i++) { M[i] = []; for (let j = 0; j <= max; j++) M[i][j] = poisson(lh, i) * poisson(la, j); }
  return M;
}
function poissonProb(key, M) {
  let s = 0;
  for (let i = 0; i < M.length; i++) for (let j = 0; j < M.length; j++) if (settle(key, i, j)) s += M[i][j];
  return s;
}

function teamGoals(side, where) {
  const L = side?.league;
  if (!L || !(num(L.fixtures?.played?.total) > 0)) return { gf: null, ga: null };
  return {
    gf: num(L.goals?.for?.average?.[where]) ?? num(L.goals?.for?.average?.total),
    ga: num(L.goals?.against?.average?.[where]) ?? num(L.goals?.against?.average?.total),
  };
}
function expectedGoals(pred) {
  const h = teamGoals(pred?.teams?.home, 'home');
  const a = teamGoals(pred?.teams?.away, 'away');
  const lh = mean([h.gf, a.ga]) ?? 1.45;
  const la = mean([a.gf, h.ga]) ?? 1.15;
  // On tire légèrement vers la moyenne pour éviter les excès en début de saison.
  return {
    lh: clamp(0.75 * lh + 0.25 * 1.45, 0.25, 3.8),
    la: clamp(0.75 * la + 0.25 * 1.15, 0.2, 3.5),
    hFor: h.gf, hAg: h.ga, aFor: a.gf, aAg: a.ga,
  };
}

function fairProbs(odds) {
  const imp = k => (odds[k] ? 1 / odds[k] : null);
  const fair = {};
  const group = (keys, total = 1) => {
    const v = keys.map(imp);
    if (v.every(Boolean)) { const s = v.reduce((a, b) => a + b, 0); keys.forEach((k, i) => { fair[k] = (v[i] / s) * total; }); }
  };
  group(['1X2:H', '1X2:D', '1X2:A']);
  if (fair['1X2:H']) {
    fair['DC:HD'] = fair['1X2:H'] + fair['1X2:D'];
    fair['DC:AD'] = fair['1X2:A'] + fair['1X2:D'];
    fair['DC:HA'] = fair['1X2:H'] + fair['1X2:A'];
  } else group(['DC:HD', 'DC:AD', 'DC:HA'], 2);
  for (const line of OU_LINES) group([`OU:O:${line}`, `OU:U:${line}`]);
  group(['BTTS:Y', 'BTTS:N']);
  const cs = Object.keys(odds).filter(k => k.startsWith('CS:'));
  const csSum = cs.reduce((a, k) => a + imp(k), 0);
  cs.forEach(k => { fair[k] = imp(k) / Math.max(1, csSum); });
  return fair;
}

function apiPercents(pred) {
  const p = pred?.predictions?.percent;
  const H = num(p?.home), D = num(p?.draw), A = num(p?.away);
  if (H == null || D == null || A == null || H + D + A < 50) return {};
  const s = H + D + A;
  const h = H / s, d = D / s, a = A / s;
  return { '1X2:H': h, '1X2:D': d, '1X2:A': a, 'DC:HD': h + d, 'DC:AD': a + d, 'DC:HA': h + a };
}

function modelProb(key, fair, pois, api, odd) {
  const f = fair[key] ?? (1 / odd) * 0.94;
  const a = api[key];
  const p = a != null ? 0.5 * f + 0.3 * pois + 0.2 * a : 0.6 * f + 0.4 * pois;
  return clamp(p, 0.005, 0.97);
}

/* ---------- Construction d’un match analysé ---------- */
const FORM = { W: 'V', D: 'N', L: 'D' };
const lastForm = s => (s || '').slice(-5).split('').map(c => FORM[c] || c).join('');
const fr = n => (n == null ? '?' : String(round(n, 1)).replace('.', ','));

function buildFixture(f, odds, pred, ctx = {}) {
  const league = LEAGUE_BY_ID.get(f.league.id);
  const home = f.teams.home.name, away = f.teams.away.name;
  const xg = expectedGoals(pred);
  const M = scoreMatrix(xg.lh, xg.la);
  const fair = fairProbs(odds);
  const api = apiPercents(pred);
  const candidates = Object.entries(odds).map(([key, cote]) => {
    const p = modelProb(key, fair, poissonProb(key, M), api, cote);
    return { cid: `${f.fixture.id}|${key}`, fixture: f.fixture.id, key, pari: label(key, home, away), cote: round(cote, 2), p: round(p), book: round(1 / cote) };
  });
  const scores = candidates.filter(c => c.key.startsWith('CS:')).sort((a, b) => b.p - a.p).slice(0, 3).map(c => [c.key.slice(3), c.p, c.cote]);
  const probOf = key => round(candidates.find(c => c.key === key)?.p ?? poissonProb(key, M), 3);
  const sniper = scorerCandidates(f, xg, pred, ctx);
  const h2h = (pred?.h2h ?? [])
    .filter(x => x.goals?.home != null)
    .sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date))
    .slice(0, 5)
    .map(x => `${x.teams.home.name} ${x.goals.home}-${x.goals.away} ${x.teams.away.name}`);
  return {
    id: f.fixture.id,
    day: dayKey(new Date(f.fixture.date)),
    time: timeLabel(f.fixture.date),
    kickoff: new Date(f.fixture.date).toISOString(),
    comp: league.name,
    group: league.group,
    home, away,
    homeLogo: f.teams.home.logo || '',
    awayLogo: f.teams.away.logo || '',
    formH: lastForm(pred?.teams?.home?.league?.form),
    formA: lastForm(pred?.teams?.away?.league?.form),
    stats: xg,
    advice: pred?.predictions?.advice || '',
    h2h,
    candidates,
    sniper,
    scores,
    probs: { h: probOf('1X2:H'), d: probOf('1X2:D'), a: probOf('1X2:A') },
  };
}

// Buteurs : taux de buts par match du joueur, ajusté selon les buts attendus
// de son équipe dans ce match (défense adverse comprise). Les blessés sont exclus.
function scorerCandidates(f, xg, pred, ctx) {
  const out = [];
  const sides = [
    { team: f.teams.home, lambda: xg.lh, avg: num(pred?.teams?.home?.league?.goals?.for?.average?.total) },
    { team: f.teams.away, lambda: xg.la, avg: num(pred?.teams?.away?.league?.goals?.for?.average?.total) },
  ];
  for (const side of sides) {
    const ratio = side.avg > 0 ? clamp(side.lambda / side.avg, 0.6, 1.6) : 1;
    for (const pl of ctx.scorers?.get(side.team.id) ?? []) {
      if (pl.apps < 3 || pl.goals < 2) continue;
      if (ctx.injured?.has(`${f.fixture.id}-${pl.id}`)) continue;
      const model = clamp(1 - Math.exp(-(pl.goals / pl.apps) * ratio), 0.02, 0.65);
      const bookOdd = findScorerOdd(ctx.scorerOdds, pl);
      const est = !bookOdd;
      const p = est ? model : 0.5 * model + 0.5 * (0.93 / bookOdd);
      out.push({
        cid: `${f.fixture.id}|SC:${pl.id}`, fixture: f.fixture.id, key: `SC:${pl.id}`,
        pari: `${pl.name} marque`, cote: round(est ? Math.max(1.2, 0.92 / model) : bookOdd, 2),
        p: round(p), book: est ? null : round(1 / bookOdd), est,
        player: { name: pl.name, team: side.team.name, goals: pl.goals, apps: pl.apps, pens: pl.pens },
      });
    }
  }
  return out;
}

function fallbackWhy(c, fx) {
  const type = c.key.split(':')[0];
  if (type === 'SC') return `${c.player.name} a marqué ${c.player.goals} buts en ${c.player.apps} matchs cette saison.`;
  if (c.key === '1X2:D') return `Le modèle estime le nul à ${Math.round(c.p * 100)} %, avec ${fr(fx.stats.lh + fx.stats.la)} buts attendus au total. Forme : ${fx.home} ${fx.formH || '?'}, ${fx.away} ${fx.formA || '?'}.`;
  if (type === 'OU' || type === 'BTTS' || type === 'CS') {
    return `${fx.home} marque ${fr(fx.stats.hFor)} et encaisse ${fr(fx.stats.hAg)} but par match à domicile, ${fx.away} ${fr(fx.stats.aFor)} et ${fr(fx.stats.aAg)} à l’extérieur.`;
  }
  if (fx.formH || fx.formA) return `Forme récente (V victoire, N nul, D défaite) : ${fx.home} ${fx.formH || '?'}, ${fx.away} ${fx.formA || '?'}.`;
  return `Le modèle estime ce pari à ${Math.round(c.p * 100)} %${c.book ? `, contre ${Math.round(c.book * 100)} % pour le bookmaker` : ''}.`;
}

/* ---------- Sélection par mode ---------- */
const SCORE = {
  safe: c => c.p + 0.5 * (c.p - c.book),
  crazy: c => (c.p - c.book) + 0.1 * c.p,
  rich: c => c.p * c.cote,
  draw: c => c.p + 0.5 * (c.p - c.book),
  sniper: c => c.p + (c.est ? 0 : 0.5 * (c.p - c.book)),
};
function pool(tier, all) {
  const r = TIER_RULES[tier];
  return all
    .filter(c => {
      if (c.cote < r.minOdds || c.cote > r.maxOdds || c.p < r.minProb) return false;
      if (tier === 'draw') return c.key === '1X2:D';
      if (tier === 'sniper') return c.key.startsWith('SC:');
      if (c.key.startsWith('SC:')) return false;
      return tier === 'rich' || !c.key.startsWith('CS:');
    })
    .sort((a, b) => SCORE[tier](b) - SCORE[tier](a));
}
function fallbackPicks(tier, list) {
  const out = [], seen = new Set();
  for (const c of list) {
    if (seen.has(c.fixture)) continue;
    seen.add(c.fixture);
    out.push({ ...c, ia: c.p, why: null });
    if (out.length >= TIER_RULES[tier].max) break;
  }
  return out;
}
const cleanWhy = s => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, 220) : null);

function picksFromClaude(tier, answer, list) {
  const byCid = new Map(list.map(c => [c.cid, c]));
  const out = [], seen = new Set();
  for (const x of Array.isArray(answer) ? answer : []) {
    const c = byCid.get(x?.cid);
    if (!c || seen.has(c.fixture)) continue;
    seen.add(c.fixture);
    const proba = clamp(num(x.proba) ?? c.p, c.p - 0.05, c.p + 0.05);
    out.push({ ...c, ia: round(clamp(proba, 0.01, 0.98)), why: cleanWhy(x.pourquoi) });
    if (out.length >= TIER_RULES[tier].max) break;
  }
  return out.length ? out : fallbackPicks(tier, list);
}

/* ---------- Claude ---------- */
const SYSTEM = `Tu es l’analyste de Lucarne, un site de pronostics foot entre amis.
Tu reçois des matchs avec leurs statistiques et, pour chaque mode (safe, crazy, rich, draw, sniper), une liste de paris candidats avec leur cote, la probabilité de notre modèle (proba_modele) et celle du bookmaker (proba_bookmaker).

Ta mission :
- Pour safe, crazy et rich, choisis jusqu’à 6 paris parmi les candidats de ce mode, au plus un par match et par mode. Privilégie les paris où proba_modele dépasse proba_bookmaker et où les stats vont dans le même sens. En safe, la sécurité passe avant la cote. En crazy, cherche le meilleur rapport entre risque et cote. En rich, vise les grosses cotes qui restent plausibles.
- Pour draw, choisis jusqu’à 6 matchs (candidats « Match nul ») qui ont le plus de chances de finir à égalité : équipes de niveau proche, défenses solides, peu de buts attendus, nuls fréquents en forme récente ou en confrontations.
- Pour sniper (buteurs), choisis jusqu’à 6 joueurs parmi les candidats, au plus un par match. Appuie-toi sur leurs buts cette saison, les buts attendus de leur équipe dans ce match et la défense adverse. Quand cote_estimee vaut true, le bookmaker ne propose pas de cote : ne parle pas de value.
- Pour var, choisis jusqu’à 6 matchs parmi var_matchs, ceux où un score exact te paraît le plus lisible.
- Pour chaque choix, donne ta probabilité (proba, entre 0 et 1, avec au plus 0,05 d’écart avec proba_modele) et une explication en français de 160 caractères maximum, appuyée uniquement sur les données fournies. N’invente jamais de blessure, de suspension, de transfert ou de statistique absente des données.

Réponds uniquement avec un objet JSON, sans texte autour, au format :
{"safe":[{"cid":"…","proba":0.8,"pourquoi":"…"}],"crazy":[…],"rich":[…],"draw":[…],"sniper":[…],"var":[{"match":123,"pourquoi":"…"}]}`;

async function askClaude(payload) {
  if (!CLAUDE_KEY) { console.warn('ANTHROPIC_API_KEY absente : sélection automatique sans Claude.'); return null; }
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: JSON.stringify(payload) }] }),
    });
    if (!res.ok) { console.warn(`Claude a répondu ${res.status} : ${(await res.text()).slice(0, 300)}`); return null; }
    const data = await res.json();
    const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end <= start) { console.warn('Réponse de Claude sans JSON.'); return null; }
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    console.warn('Appel à Claude impossible :', e.message);
    return null;
  }
}

/* ---------- Résultats et bilan ---------- */
const VOID = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);
const DONE = new Set(['FT', 'AET', 'PEN']);
const LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE', 'SUSP']);
const MATCH_MS = 100 * 60e3;   // un match dure environ 1 h 45 avec la mi-temps

// Récupère le score des matchs commencés, l’écrit dans pronos.json (pour les
// coches « Validé / Pas validé » du site) et règle les pronos du bilan.
async function refreshResults(pronos, history) {
  const now = Date.now();
  pronos.results ||= {};
  // Le plan gratuit ne permet pas de demander des matchs par identifiant :
  // on récupère tous les matchs d’une date (1 requête par jour concerné).
  const byDay = new Map();
  const want = (day, id) => {
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(Number(id));
  };
  for (const [id, m] of Object.entries(pronos.matches ?? {})) {
    if (!pronos.results[id]?.final && Date.parse(m.kickoff) <= now) want(m.day, id);
  }
  for (const p of history.picks) {
    if (p.status === 'pending' && Date.parse(p.kickoff) < now - MATCH_MS) want(p.day || dayKey(new Date(p.kickoff)), p.fixture);
  }
  if (!byDay.size) { console.log('Aucun match commencé à vérifier.'); return; }

  const byId = new Map();
  for (const [day, ids] of byDay) {
    try {
      const response = await football('/fixtures', { date: day, timezone: TIMEZONE });
      for (const f of response) if (ids.has(f.fixture.id)) byId.set(f.fixture.id, f);
    } catch (e) { console.warn('Résultats indisponibles :', e.message); }
  }

  let finished = 0;
  for (const [id, f] of byId) {
    const m = pronos.matches?.[id];
    if (!m || Date.parse(m.kickoff) > now) continue;
    const st = f.fixture.status.short;
    const h = f.score?.fulltime?.home ?? f.goals?.home;
    const a = f.score?.fulltime?.away ?? f.goals?.away;
    if (VOID.has(st)) pronos.results[id] = { status: 'void', final: true };
    else if (DONE.has(st) && h != null && a != null) { pronos.results[id] = { status: 'FT', score: `${h}-${a}`, final: true }; finished++; }
    else if (LIVE.has(st) && f.goals?.home != null) pronos.results[id] = { status: 'live', score: `${f.goals.home}-${f.goals.away}`, at: new Date().toISOString(), final: false };
  }
  if (byId.size) pronos.resultsAt = new Date().toISOString();

  // Buteurs : on récupère les buts d’un match une seule fois, quand il est terminé.
  const needGoals = new Set();
  for (const p of pronos.picks ?? []) {
    const r = pronos.results[p.m];
    if (p.key?.startsWith('SC:') && r?.status === 'FT' && !r.scorers) needGoals.add(Number(p.m));
  }
  for (const p of history.picks) {
    if (p.status === 'pending' && p.key?.startsWith('SC:') && DONE.has(byId.get(p.fixture)?.fixture?.status?.short)) needGoals.add(p.fixture);
  }
  const goalsBy = new Map();
  for (const id of needGoals) {
    try {
      const events = await football('/fixtures/events', { fixture: id, type: 'Goal' });
      const scorers = events
        .filter(e => String(e.type).toLowerCase() === 'goal' && !/own goal|missed penalty/i.test(e.detail || ''))
        .map(e => e.player?.id).filter(Boolean);
      goalsBy.set(id, scorers);
      if (pronos.results[id]) pronos.results[id].scorers = scorers;
    } catch (e) { console.warn('Buteurs du match indisponibles :', e.message); }
  }

  for (const p of history.picks) {
    if (p.status !== 'pending') continue;
    const f = byId.get(p.fixture);
    if (!f) { if (now - Date.parse(p.kickoff) > 3 * DAY_MS) p.status = 'void'; continue; }
    const st = f.fixture.status.short;
    if (VOID.has(st)) { p.status = 'void'; continue; }
    if (!DONE.has(st)) continue;
    const h = f.score?.fulltime?.home ?? f.goals?.home;
    const a = f.score?.fulltime?.away ?? f.goals?.away;
    if (h == null || a == null) continue;
    p.score = `${h}-${a}`;
    const scorers = goalsBy.get(p.fixture) ?? pronos.results?.[p.fixture]?.scorers;
    const ok = settle(p.key, h, a, scorers);
    if (ok === null) continue;   // buteur : on attend la liste des buts
    p.status = ok ? 'won' : 'lost';
  }
  console.log(`Résultats : ${finished} match(s) terminé(s) mis à jour.`);
}

function pruneHistory(history) {
  const limit = Date.now() - 60 * DAY_MS;
  history.picks = history.picks.filter(p => Date.parse(p.kickoff) >= limit);
}

// Passage rapide toutes les heures : seulement les scores, sans nouvelle analyse.
async function resultsOnly() {
  const pronos = await readJson('pronos.json', null);
  const history = await readJson('history.json', { picks: [] });
  history.picks ||= [];
  if (!pronos?.generatedAt) { console.log('Pas encore de pronos : rien à vérifier.'); return; }
  await refreshResults(pronos, history);
  pruneHistory(history);
  await writeJson('pronos.json', pronos);
  await writeJson('history.json', history);
  console.log(`Terminé : ${calls} requête(s) API-Football.`);
}

/* ---------- Buteurs et blessés ---------- */
// Meilleurs buteurs de chaque compétition, gardés en cache quelques jours
// (data/scorers.json) pour économiser les requêtes.
async function loadScorers(fixtures) {
  const cache = await readJson('scorers.json', { leagues: {} });
  cache.leagues ||= {};
  const wanted = new Map();
  for (const f of fixtures) wanted.set(`${f.league.id}-${f.league.season}`, f.league);
  const freshSince = Date.now() - SCORERS_REFRESH_DAYS * DAY_MS;
  for (const [k, lg] of wanted) {
    if (cache.leagues[k] && Date.parse(cache.leagues[k].at) > freshSince) continue;
    try {
      const response = await football('/players/topscorers', { league: lg.id, season: lg.season });
      cache.leagues[k] = {
        at: new Date().toISOString(),
        players: response.map(r => {
          const st = r.statistics?.[0] ?? {};
          return {
            id: r.player?.id, name: r.player?.name, first: r.player?.firstname || '', last: r.player?.lastname || '',
            teamId: st.team?.id, team: st.team?.name,
            goals: num(st.goals?.total) ?? 0, apps: num(st.games?.appearences) ?? 0, pens: num(st.penalty?.scored) ?? 0,
          };
        }).filter(pl => pl.id && pl.teamId),
      };
      console.log(`Buteurs mis à jour : ${LEAGUE_BY_ID.get(lg.id)?.name ?? lg.id}`);
    } catch (e) { console.warn('Buteurs indisponibles :', e.message); }
  }
  for (const [k, v] of Object.entries(cache.leagues)) if (Date.parse(v.at) < Date.now() - 30 * DAY_MS) delete cache.leagues[k];
  await writeJson('scorers.json', cache);
  const byTeam = new Map();
  for (const k of wanted.keys()) {
    for (const pl of cache.leagues[k]?.players ?? []) {
      if (!byTeam.has(pl.teamId)) byTeam.set(pl.teamId, []);
      byTeam.get(pl.teamId).push(pl);
    }
  }
  return byTeam;
}

// Joueurs blessés ou suspendus (une requête par jour analysé).
async function loadInjuries(days) {
  const out = new Set();
  for (const d of days) {
    try {
      const response = await football('/injuries', { date: d, timezone: TIMEZONE });
      for (const r of response) if (r.fixture?.id && r.player?.id) out.add(`${r.fixture.id}-${r.player.id}`);
    } catch (e) { console.warn('Blessures indisponibles :', e.message); }
  }
  return out;
}

/* ---------- Programme principal ---------- */
async function main() {
  if (!FOOT_KEY) throw new Error('Le secret APIFOOTBALL_KEY est manquant.');
  await mkdir(DATA_DIR, { recursive: true });
  if (MODE === 'resultats') return resultsOnly();

  const history = await readJson('history.json', { picks: [] });
  history.picks ||= [];
  const previous = await readJson('pronos.json', null);

  const now = new Date();
  const days = [dayKey(now), dayKey(new Date(now.getTime() + DAY_MS))];
  let fixtures = [];
  for (const d of days) {
    const list = await football('/fixtures', { date: d, timezone: TIMEZONE });
    fixtures.push(...list.filter(f => LEAGUE_BY_ID.has(f.league.id) && f.fixture.status.short === 'NS'));
  }
  fixtures.sort((a, b) => LEAGUE_BY_ID.get(a.league.id).rank - LEAGUE_BY_ID.get(b.league.id).rank || a.fixture.timestamp - b.fixture.timestamp);
  fixtures = fixtures.slice(0, MAX_FIXTURES);
  console.log(`${fixtures.length} matchs à analyser.`);
  const scorersByTeam = await loadScorers(fixtures);
  const injured = await loadInjuries(days);

  const analysed = [], errors = [];
  for (const f of fixtures) {
    const name = `${f.teams.home.name} – ${f.teams.away.name}`;
    try {
      const oddsResponse = await football('/odds', { fixture: f.fixture.id });
      const odds = collectOdds(oddsResponse);
      if (!odds['1X2:H'] && !odds['OU:O:2.5']) { console.log(`Pas de cotes pour ${name}, match ignoré.`); continue; }
      let pred = null;
      try { pred = (await football('/predictions', { fixture: f.fixture.id }))[0] ?? null; }
      catch (e) { errors.push(e.message); }
      analysed.push(buildFixture(f, odds, pred, { scorers: scorersByTeam, injured, scorerOdds: collectScorerOdds(oddsResponse) }));
      console.log(`Analysé : ${name}`);
    } catch (e) {
      errors.push(e.message);
      console.warn(`${name} : ${e.message}`);
    }
  }
  if (!analysed.length && errors.length) throw new Error(`Aucun match analysé. Première erreur : ${errors[0]}`);

  const byId = new Map(analysed.map(fx => [fx.id, fx]));
  const all = analysed.flatMap(fx => [...fx.candidates, ...fx.sniper]);
  const TIERS = ['safe', 'crazy', 'rich', 'draw', 'sniper'];
  const pools = Object.fromEntries(TIERS.map(t => [t, pool(t, all)]));
  const varFixtures = analysed.filter(fx => fx.scores.length >= 2);

  let answer = null;
  if (analysed.length) {
    answer = await askClaude({
      matchs: analysed.map(fx => ({
        id: fx.id,
        match: `${fx.home} – ${fx.away}`,
        competition: fx.comp,
        coup_envoi: `${dayLabel(fx.day)} à ${fx.time}`,
        forme_domicile: fx.formH || null,
        forme_exterieur: fx.formA || null,
        buts_par_match_domicile: { marques: fx.stats.hFor, encaisses: fx.stats.hAg },
        buts_par_match_exterieur: { marques: fx.stats.aFor, encaisses: fx.stats.aAg },
        buts_attendus_modele: { domicile: round(fx.stats.lh, 2), exterieur: round(fx.stats.la, 2) },
        confrontations_recentes: fx.h2h,
        conseil_stats: fx.advice || null,
        scores_probables: fx.scores.map(([s, p, c]) => ({ score: s, proba_modele: p, cote: c })),
      })),
      candidats: Object.fromEntries(Object.entries(pools).map(([t, list]) => [t, list.slice(0, 30).map(c => ({
        cid: c.cid, match_id: c.fixture, pari: c.pari, cote: c.cote, proba_modele: c.p, proba_bookmaker: c.book,
        ...(c.player ? { joueur: c.player.name, equipe: c.player.team, buts_saison: c.player.goals, matchs_joues: c.player.apps, penalties_marques: c.player.pens, cote_estimee: c.est } : {}),
      }))])),
      var_matchs: varFixtures.map(fx => fx.id),
    });
  }
  const top = t => pools[t].slice(0, 30);
  const chosen = Object.fromEntries(TIERS.map(t => [t, answer ? picksFromClaude(t, answer[t], top(t)) : fallbackPicks(t, pools[t])]));

  const picks = [];
  for (const [t, list] of Object.entries(chosen)) {
    for (const c of list) {
      const fx = byId.get(c.fixture);
      picks.push({
        id: `${t}-${c.fixture}`, t, m: c.fixture, key: c.key, pari: c.pari, cote: c.cote, ia: c.ia, why: c.why || fallbackWhy(c, fx),
        ...(c.player ? { sub: c.player.team } : {}), ...(c.est ? { est: true } : {}),
      });
    }
  }

  let varList = [];
  const varAnswer = Array.isArray(answer?.var) ? answer.var : [];
  for (const x of varAnswer) {
    const fx = byId.get(Number(x?.match));
    if (!fx || fx.scores.length < 2 || varList.some(v => v.m === fx.id)) continue;
    varList.push({ m: fx.id, why: cleanWhy(x.pourquoi), scores: fx.scores });
    if (varList.length >= TIER_RULES.var.max) break;
  }
  if (!varList.length) {
    varList = [...varFixtures].sort((a, b) => b.scores[0][1] - a.scores[0][1]).slice(0, TIER_RULES.var.max).map(fx => ({ m: fx.id, why: null, scores: fx.scores }));
  }
  varList.forEach(v => { v.why ||= fallbackWhy({ key: 'CS:' + v.scores[0][0], p: v.scores[0][1], book: 1 / v.scores[0][2] }, byId.get(v.m)); });

  const usedIds = new Set([...picks.map(p => p.m), ...varList.map(v => v.m)]);
  const matches = {};
  for (const id of usedIds) {
    const fx = byId.get(id);
    matches[id] = {
      day: fx.day, time: fx.time, kickoff: fx.kickoff, comp: fx.comp, group: fx.group,
      home: fx.home, away: fx.away, homeLogo: fx.homeLogo, awayLogo: fx.awayLogo,
      info: {   // pour la fiche match du site
        formH: fx.formH, formA: fx.formA, h2h: fx.h2h, advice: fx.advice || '',
        gH: { f: fx.stats.hFor, a: fx.stats.hAg }, gA: { f: fx.stats.aFor, a: fx.stats.aAg },
        xg: { h: round(fx.stats.lh, 2), a: round(fx.stats.la, 2) }, probs: fx.probs,
      },
    };
  }

  const pronos = {
    generatedAt: now.toISOString(),
    days: days.map(key => ({ key, label: dayLabel(key) })),
    matches,
    picks,
    var: varList,
    results: {},
    source: answer ? 'claude' : 'modele',
  };

  // Bilan : on enregistre les pronos des matchs du jour (ceux de demain seront
  // recalculés demain matin avec des cotes plus fraîches).
  const today = days[0];
  history.picks = history.picks.filter(p => !(p.status === 'pending' && p.day === today && Date.parse(p.kickoff) > Date.now()));
  const record = (tier, fixture, key, pari, cote, ia, est) => {
    const fx = byId.get(fixture);
    const id = `${today}-${tier}-${fixture}`;
    if (!fx || fx.day !== today || history.picks.some(h => h.id === id)) return;
    history.picks.push({ id, fixture, tier, key, pari, match: `${fx.home} – ${fx.away}`, cote, ia, kickoff: fx.kickoff, day: today, status: 'pending', ...(est ? { est: true } : {}) });
  };
  picks.forEach(p => record(p.t, p.m, p.key, p.pari, p.cote, p.ia, p.est));
  varList.forEach(v => record('var', v.m, 'CS:' + v.scores[0][0], 'Score exact ' + v.scores[0][0], v.scores[0][2], v.scores[0][1]));

  // On garde les pronos d’hier (onglet « Hier », avec leurs résultats) et, si
  // l’analyse est relancée dans la journée, ceux des matchs du jour déjà commencés.
  const yesterday = dayKey(new Date(now.getTime() - DAY_MS));
  for (const [id, m] of Object.entries(previous?.matches ?? {})) {
    const keep = m.day === yesterday || (m.day === today && Date.parse(m.kickoff) <= Date.now());
    if (matches[id] || !keep) continue;
    matches[id] = m;
    for (const p of previous.picks ?? []) if (String(p.m) === id) picks.push(p);
    for (const v of previous.var ?? []) if (String(v.m) === id) varList.push(v);
    if (previous.results?.[id]) pronos.results[id] = previous.results[id];
  }

  if (Object.values(matches).some(m => m.day === yesterday)) {
    pronos.days.unshift({ key: yesterday, label: dayLabel(yesterday), past: true });
  }

  await refreshResults(pronos, history);
  pruneHistory(history);
  await writeJson('pronos.json', pronos);
  await writeJson('history.json', history);

  console.log(`Terminé : ${picks.length} pronos, ${varList.length} matchs en VAR, ${calls} requêtes API-Football, source ${answer ? 'Claude' : 'modèle seul'}.`);
}

main().catch(e => { console.error('Échec :', e.message); process.exit(1); });
