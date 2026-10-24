# Lucarne

Site de pronos foot analysés par IA, avec quatre modes : SAFE, CRAZY, RICH et VAR.

## Comment ça marche

Chaque matin vers 8 h (7 h en hiver), GitHub lance tout seul `scripts/generate.mjs`. Le script :

1. règle les pronos de la veille (gagné ou perdu) pour mettre à jour le bilan ;
2. récupère les matchs du jour et du lendemain, leurs cotes et leurs stats sur API-Football ;
3. calcule une probabilité pour chaque pari, en mélangeant les cotes sans la marge du bookmaker, un modèle de buts (Poisson) et les prédictions d’API-Football ;
4. envoie tout ça à Claude, qui choisit les pronos de chaque mode et écrit l’explication ;
5. publie le site sur GitHub Pages.

Si Claude ne répond pas un jour, le site se met quand même à jour avec la sélection du modèle seul.

## Mise en route (environ 20 minutes, plus simple sur ordinateur)

### 1. Les deux clés API

- **API-Football** : crée un compte gratuit sur dashboard.api-football.com, puis copie ta clé dans Account → My Access.
- **Claude** : crée un compte sur platform.claude.com (la console développeur de Claude), ajoute quelques euros de crédit, puis crée une clé dans API Keys.

### 2. Le dépôt GitHub

1. Crée un compte sur github.com si tu n’en as pas.
2. Clique sur **New repository**, nomme-le `lucarne` et coche **Public**. GitHub Pages est gratuit pour les dépôts publics, et tes clés restent secrètes.
3. **Add file → Upload files**, puis glisse tout le contenu du dossier `lucarne` (pas le dossier lui-même) et valide avec **Commit changes**.
4. Vérifie que le fichier `.github/workflows/pronos.yml` est bien arrivé. Sur Mac et Windows, les dossiers qui commencent par un point sont souvent cachés et ne partent pas. S’il manque : **Add file → Create new file**, tape `.github/workflows/pronos.yml` comme nom, colle le contenu du fichier, puis **Commit changes**.

### 3. Les secrets

Dans le dépôt : **Settings → Secrets and variables → Actions → New repository secret**, deux fois :

- `APIFOOTBALL_KEY` avec ta clé API-Football ;
- `ANTHROPIC_API_KEY` avec ta clé Claude.

### 4. GitHub Pages

**Settings → Pages → Source : GitHub Actions.**

### 5. Premier lancement

Onglet **Actions → Pronos du jour → Run workflow**. L’analyse prend environ 6 minutes, parce que le plan gratuit impose une pause entre les requêtes. Ton site est ensuite en ligne à l’adresse `https://TON-PSEUDO.github.io/lucarne/`.

Après ça, tout tourne seul chaque matin.

## Coûts

- **API-Football gratuit** : 100 requêtes par jour, le script en utilise environ 50.
- **Claude** (modèle `claude-sonnet-5-5`) : quelques centimes par jour.
- **GitHub et GitHub Pages** : gratuits.

## Si ça bloque

- **Le workflow échoue avec un message du type « Free plans do not have access to this season »** : le plan gratuit d’API-Football ne couvre pas toujours la saison en cours. Passe au plan Pro (19 $ par mois), puis dans `scripts/config.mjs`, baisse `REQUEST_DELAY_MS` à 300 et monte `MAX_FIXTURES` à 80.
- **Le site affiche « Impossible de charger les pronos »** : regarde dans l’onglet Actions si le dernier passage est vert. Clique dessus pour lire l’erreur.
- **Peu ou pas de pronos** : c’est normal les jours sans match dans les ligues suivies, par exemple pendant une trêve internationale.

## Personnaliser

- `scripts/config.mjs` : compétitions suivies (ids API-Football), nombre de matchs analysés, règles de chaque mode (cotes min et max, probabilité min) et modèle Claude.
- `.github/workflows/pronos.yml` : l’heure du passage quotidien, sur la ligne `cron` (en heure UTC).
- `index.html` : tout le design du site.

## Bon à savoir

Les probabilités sont des estimations, jamais des certitudes. Le bilan sur 30 jours, affiché dans chaque mode, montre la vraie réussite : c’est lui qu’il faut regarder avant de faire confiance à un mode.
