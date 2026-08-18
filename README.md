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
- **Identité** : pas de comptes au sens classique. Chaque coach choisit un **mot de passe d'équipe** (4 à 32
  caractères libres) en inscrivant son équipe. Le lien de gestion contient l'id d'équipe + ce mot de passe
  (`/tournaments/:id/team/:teamId/:password`) ; un bouton "J'ai déjà une équipe" permet aussi de la retrouver
  sans lien en sélectionnant son nom de coach dans une liste puis en saisissant le mot de passe.
  L'organisateur reçoit une URL admin séparée avec un jeton long (UUID, `/tournaments/:id/admin/:token`). Ces
  identifiants ne sont affichés qu'une seule fois à la création — à conserver précieusement, il n'y a aucune
  récupération possible.
- **Images de roster** : chaque coach peut envoyer une photo de sa feuille de roster (JPEG/PNG/WebP, 5 Mo max),
  visible par tout le monde en cliquant sur l'équipe dans le tableau des scores. Upload en direct
  navigateur → S3 via une URL présignée (POST policy avec limite de taille/type imposée par S3), la Lambda ne
  transite jamais le fichier lui-même.
- **Infra as code** : AWS CDK (TypeScript), pile unique `BbTournamentStack`.

Coût estimé à l'échelle d'un tournoi amateur : proche de 0 $/mois (Lambda et API Gateway HTTP API ont un palier
gratuit très large, S3 ne stocke que quelques Ko de JSON par tournoi + quelques Mo d'images de roster, CloudFront
reste très en dessous du palier gratuit de 1 To/mois). Le nom de domaine utilisé est l'URL CloudFront par défaut
(`*.cloudfront.net`), donc pas de coût Route53/domaine pour l'instant.

## Structure du repo (monorepo npm workspaces)

```
shared/    Types TypeScript + logique de scoring, partagés entre backend et frontend
backend/   Lambda (Hono), stockage S3, endpoints REST
infra/     AWS CDK (S3, Lambda, API Gateway HTTP API, CloudFront)
frontend/  Application Angular
```

## Fonctionnalités (v1)

- Créer un tournoi (génère un lien admin, affiché une seule fois).
- S'inscrire avec une équipe (nom, coach, race, mot de passe libre de 4 à 32 caractères choisi par le coach — pas
  de gestion de roster/joueurs individuels).
- Retrouver son équipe via un bouton "J'ai déjà une équipe" : sélection du nom de coach dans la liste + saisie du
  mot de passe, sans avoir besoin du lien.
- Envoyer une image de roster (JPEG/PNG/WebP, 5 Mo max), visible par tous en cliquant sur l'équipe.
- Défier librement n'importe quelle autre équipe inscrite (pas de bracket, pas de round généré).
- Accepter/refuser/annuler un défi.
- Remplir la feuille de match (date du match, touchdowns, casualties, concession) ; l'adversaire confirme le
  score, ou peut proposer une correction si les valeurs ne correspondent pas.
- Tableau des scores public en temps quasi réel (rafraîchi toutes les 15s) : classement, équipes (cliquables pour
  voir le roster et l'historique des défis face à chaque adversaire), historique des défis avec leur date.
- Onglet "Description" sur le tableau des scores (règlement, planning, infos pratiques…), rédigé en Markdown et
  modifiable uniquement depuis le panneau admin.
- Panneau admin : mot de passe + lien de toutes les équipes, suppression d'équipe, forcer/débloquer un défi, forcer
  un résultat, éditer la description du tournoi (avec aperçu).

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

- Le mot de passe d'équipe (nom de coach + mot de passe, ou lien contenant `teamId` + mot de passe) et le jeton
  admin sont la seule protection : quiconque les obtient a le contrôle correspondant. Ne pas les partager
  publiquement.
- **Le mot de passe est volontairement libre en longueur (4 à 32 caractères) et non haché** (stocké en clair dans
  le JSON du tournoi, visible par l'admin) : un compromis délibéré confort/simplicité pour un tournoi amateur
  entre personnes de confiance, pas conçu pour résister à un attaquant motivé. Un throttle léger est appliqué au
  niveau de l'API Gateway (50 req/s, burst 100) comme frein de base contre le brute-force, mais ce n'est pas une
  protection forte.
- Le bucket de données a le versioning S3 activé (30 jours de rétention des anciennes versions) comme filet de
  sécurité en cas de bug d'écriture ou de mot de passe compromis (l'admin peut restaurer/corriger via son
  panneau).
