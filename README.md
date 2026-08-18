# BB Online Tournament

Site de gestion de tournois Blood Bowl au format "ladder" (défis libres entre équipes inscrites), inspiré du
règlement NAF World Cup (`inspiration/NAF-World-Cup-Rules-V2.1.pdf`) pour la feuille de match : touchdowns,
casualties, concession (forcée à 3-0) et calcul des points (Victoire 5 / Nul 2 / Défaite 0 / Concession -5).

## Architecture

Conçu pour un coût quasi nul sur AWS :

- **Frontend** : Angular, buildé en statique, servi depuis S3 derrière CloudFront (HTTPS, cache).
- **Backend** : une seule fonction Lambda (Node.js, TypeScript, routeur [Hono](https://hono.dev)) derrière une
  API Gateway HTTP API, exposée sous `/api/*` sur le même nom de domaine CloudFront (pas de CORS à gérer).
- **Données** : pas de base de données. Chaque tournoi est un unique fichier JSON dans un bucket S3
  (`tournaments/{id}.json`), avec écriture optimiste via les ETags S3 (`If-Match`/`If-None-Match`) pour éviter les
  écrasements concurrents.
- **Identité** : pas de comptes ni de mots de passe. Chaque équipe reçoit une URL secrète contenant un UUID
  (`/tournaments/:id/team/:teamId/:token`) qui sert de preuve de possession de l'équipe. L'organisateur reçoit une
  URL admin séparée (`/tournaments/:id/admin/:token`). Ces liens ne sont affichés qu'une seule fois à la création
  — à conserver précieusement, il n'y a aucune récupération possible.
- **Infra as code** : AWS CDK (TypeScript), pile unique `BbTournamentStack`.

Coût estimé à l'échelle d'un tournoi amateur : proche de 0 $/mois (Lambda et API Gateway HTTP API ont un palier
gratuit très large, S3 ne stocke que quelques Ko par tournoi, CloudFront reste très en dessous du palier gratuit
de 1 To/mois). Le nom de domaine utilisé est l'URL CloudFront par défaut (`*.cloudfront.net`), donc pas de coût
Route53/domaine pour l'instant.

## Structure du repo (monorepo npm workspaces)

```
shared/    Types TypeScript + logique de scoring, partagés entre backend et frontend
backend/   Lambda (Hono), stockage S3, endpoints REST
infra/     AWS CDK (S3, Lambda, API Gateway HTTP API, CloudFront)
frontend/  Application Angular
```

## Fonctionnalités (v1)

- Créer un tournoi (génère un lien admin, affiché une seule fois).
- S'inscrire avec une équipe (nom, coach, race — pas de gestion de roster/joueurs individuels).
- Défier librement n'importe quelle autre équipe inscrite (pas de bracket, pas de round généré).
- Accepter/refuser/annuler un défi.
- Remplir la feuille de match (touchdowns, casualties, concession) ; l'adversaire confirme le score, ou peut
  proposer une correction si les nombres ne correspondent pas.
- Tableau des scores public en temps quasi réel (rafraîchi toutes les 15s) : classement, équipes, historique des
  défis.
- Panneau admin : liens de toutes les équipes, suppression d'équipe, forcer/débloquer un défi, forcer un résultat.

Hors scope volontaire pour l'instant (cf. échanges de cadrage) : rounds générés / format squad façon NAF,
roster builder avec achat de compétences en SPP, nom de domaine personnalisé.

## Prérequis

- Node.js 20+ et npm
- Un compte AWS + [AWS CLI configuré](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html)
  avec des identifiants valides
- `npx cdk bootstrap` doit avoir été exécuté une fois par compte/région (voir plus bas)

## Développement local

```bash
npm install
npm run build:shared   # à refaire après toute modif de shared/
npm run build -w frontend -- --watch   # ou: cd frontend && npm start
```

Le frontend appelle `/api/...` en chemin relatif : en local sans backend déployé, ces appels échoueront (404/erreur
réseau) sauf à déployer d'abord le backend puis pointer temporairement vers son URL, ou à lancer la Lambda avec un
outil type SAM/`aws-lambda-local`. Le plus simple pour itérer sur l'UI seule est d'utiliser les DevTools pour
observer les erreurs réseau, puis de valider le flux complet une fois déployé.

## Déploiement

```bash
npm install
npm run cdk:bootstrap -w infra   # une seule fois par compte/région AWS
npm run build                     # build shared -> backend -> frontend -> infra
npm run deploy                    # cdk deploy (assets Angular + Lambda inclus)
```

La sortie `SiteUrl` du stack CDK est l'URL publique du site. Recommencer `npm run deploy` après chaque changement
(le build Angular et la Lambda sont re-synchronisés automatiquement, avec invalidation CloudFront).

Pour changer de région, positionner `CDK_DEFAULT_REGION` avant `cdk deploy` (par défaut `eu-west-1`).

## Notes de sécurité / limites connues

- Les liens (participant/admin) sont la seule protection : quiconque obtient un lien a le contrôle correspondant.
  Ne pas les partager publiquement.
- Pas de limite de débit (rate limiting) sur l'API — acceptable pour un usage de tournoi amateur, à revoir si le
  site devient public à grande échelle.
- Le bucket de données a le versioning S3 activé (30 jours de rétention des anciennes versions) comme filet de
  sécurité en cas de bug d'écriture.
