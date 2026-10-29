// Réglages de Lucarne : compétitions suivies, nombre de matchs, modèle d’IA.

// Compétitions analysées (id API-Football, nom affiché, groupe du filtre).
// L’ordre compte : s’il y a trop de matchs, les premières passent en priorité.
export const LEAGUES = [
  { id: 61,  name: 'Ligue 1',             group: 'Ligue 1' },
  { id: 39,  name: 'Premier League',      group: 'Premier League' },
  { id: 140, name: 'Liga',                group: 'Liga' },
  { id: 135, name: 'Serie A',             group: 'Serie A' },
  { id: 78,  name: 'Bundesliga',          group: 'Bundesliga' },
  { id: 2,   name: 'Ligue des champions', group: 'Europe' },
  { id: 3,   name: 'Ligue Europa',        group: 'Europe' },
  { id: 848, name: 'Ligue Conférence',    group: 'Europe' },
  { id: 62,  name: 'Ligue 2',             group: 'Autres' },
  { id: 88,  name: 'Eredivisie',          group: 'Autres' },
  { id: 94,  name: 'Liga Portugal',       group: 'Autres' },
  { id: 144, name: 'Jupiler Pro League',  group: 'Autres' },
];

// Nombre max de matchs analysés chaque matin. Chaque match coûte 2 requêtes
// API-Football (cotes + stats). Avec les buteurs, les blessés et les scores de
// la journée, 22 matchs gardent le total sous la limite gratuite de 100 par jour.
// Avec le plan Pro, tu peux monter à 80 ou plus.
export const MAX_FIXTURES = 22;

// Pause entre deux requêtes : le plan gratuit limite à 10 requêtes par minute.
// Avec le plan Pro, tu peux descendre à 300.
export const REQUEST_DELAY_MS = 6500;

// Les meilleurs buteurs de chaque championnat sont gardés en mémoire ce nombre de jours.
export const SCORERS_REFRESH_DAYS = 4;

export const TIMEZONE = 'Europe/Paris';

// Modèle Claude qui choisit et explique les pronos.
export const MODEL = 'claude-sonnet-5-5';

// Règles de chaque mode : cotes acceptées, probabilité minimale, nombre de pronos.
export const TIER_RULES = {
  safe:   { minOdds: 1.15, maxOdds: 1.65, minProb: 0.68, max: 6 },
  crazy:  { minOdds: 1.80, maxOdds: 3.60, minProb: 0.28, max: 6 },
  rich:   { minOdds: 5.00, maxOdds: 60,   minProb: 0.04, max: 6 },
  draw:   { minOdds: 2.60, maxOdds: 4.60, minProb: 0.20, max: 6 },
  sniper: { minOdds: 1.40, maxOdds: 8,    minProb: 0.22, max: 6 },
  var:    { max: 6 },
};
