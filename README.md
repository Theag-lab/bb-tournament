# BB Online Tournament

Site de gestion de tournois Blood Bowl, avec trois formats au choix (ladder libre, rondes suisses, ou suisses
avec défis en 1ère ronde), inspiré du règlement NAF World Cup (`inspiration/NAF-World-Cup-Rules-V2.1.pdf`) pour la
feuille de match : touchdowns, casualties, concession (forcée à 3-0) et calcul des points (Victoire 5 / Nul 2 /
Défaite 0 / Concession -5).

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

## Fonctionnalités

- Créer un tournoi via un tunnel en plusieurs étapes (nom → format → nombre de rondes si besoin → vérification
  des rosters → récapitulatif), qui génère un lien admin affiché une seule fois.
- **Trois formats de tournoi**, choisis à la création (non modifiable ensuite) :
  - **Défi libre (ladder)** : chaque coach défie qui il veut, à tout moment, comme avant.
  - **Rondes suisses** : pas de défi libre. L'admin génère chaque ronde (appariement aléatoire pour la ronde 1,
    puis par classement — en évitant les revanches quand c'est possible — pour les suivantes), peut échanger des
    paires tant que la ronde est en brouillon, puis la lance. La ronde suivante ne peut être générée que lorsque
    tous les matchs de la précédente sont terminés. Un nombre pair d'équipes est requis pour générer une ronde
    (pas de "bye" : il faut attendre une équipe supplémentaire). Les inscriptions se ferment dès qu'une ronde a
    été générée. Les fiches d'équipe (nom, coach, race, image de roster) restent masquées aux autres participants
    tant que la ronde 1 n'est pas lancée (tirage à l'aveugle) — chacun voit toujours sa propre équipe.
  - **Rondes suisses avec défis en 1ère ronde** : les coachs peuvent se défier librement avant que l'admin ne
    génère la ronde 1 (un seul défi actif à la fois par équipe) ; les défis acceptés deviennent des paires fixes
    de la ronde 1, le reste des équipes est apparié aléatoirement. À partir de la génération de la ronde 1, le
    tournoi bascule en rondes classiques (plus de défi libre). Ici les équipes restent visibles dès le début
    (nécessaire pour choisir un adversaire).
  - Un onglet par ronde lancée apparaît sur le tableau des scores public ; côté coach, le match de la ronde en
    cours apparaît dans "Mes défis" avec la feuille de match habituelle.
- S'inscrire avec une équipe (nom, coach, race, mot de passe libre de 4 à 32 caractères choisi par le coach — pas
  de gestion de roster/joueurs individuels).
- Retrouver son équipe via un bouton "J'ai déjà une équipe" : sélection du nom de coach dans la liste + saisie du
  mot de passe, sans avoir besoin du lien.
- Envoyer une image de roster (JPEG/PNG/WebP, 5 Mo max), visible par tous en cliquant sur l'équipe.
- Accepter/refuser/annuler un défi.
- Remplir la feuille de match (date du match, touchdowns, casualties, agressions, concession) ; l'adversaire
  confirme le score, ou peut proposer une correction si les valeurs ne correspondent pas.
- Tableau des scores public en temps quasi réel (rafraîchi toutes les 15s) : classement (avec race, V-N-D, points,
  TD et casualties), équipes (cliquables pour voir le roster et l'historique des défis face à chaque adversaire),
  historique des défis avec date, TD et casualties des deux coachs.
- Onglet "Scores secondaires" : classements Bashlord (plus de casualties infligées), AggroLord (plus
  d'agressions infligées) et Meilleur marqueur (plus de touchdowns marqués).
- Onglet "Description" sur le tableau des scores (règlement, planning, infos pratiques…), rédigé en Markdown et
  modifiable uniquement depuis le panneau admin.
- Panneau admin : mot de passe + lien de toutes les équipes, suppression d'équipe, forcer/débloquer un défi, forcer
  un résultat, éditer la description du tournoi (avec aperçu), et en format suisse : générer/échanger/lancer les
  rondes.
- **Vérification des rosters (optionnelle)** : à la création du tournoi, l'admin peut activer "la vérification des
  rosters". Chaque équipe passe alors par un statut visible de tous (Créée → Soumise pour validation → Validée) :
  le coach envoie sa capture d'écran puis la soumet pour validation ; l'admin valide ou renvoie pour modification
  depuis son panneau ; une fois validée, l'image ne peut plus être remplacée par le coach (l'admin garde la main).
  Tant que son roster n'est pas validé, une équipe ne peut pas défier une autre équipe (elle peut en revanche
  toujours être défiée et accepter un défi). Si l'option n'est pas activée à la création, aucun statut n'est
  affiché nulle part, l'image reste librement modifiable et les défis restent totalement libres — ce comportement
  (option désactivée) est celui de tous les tournois créés avant l'ajout de cette fonctionnalité.

Hors scope volontaire pour l'instant (cf. échanges de cadrage) : format squad façon NAF (6 coachs par équipe de
tournoi), roster builder avec achat de compétences en SPP, nom de domaine personnalisé, "bye" pour un nombre
impair d'équipes (actuellement bloqué plutôt que compensé).

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

## Migration de données existantes

Le schéma JSON des tournois évolue avec les fonctionnalités (aucune base de données, donc aucune migration
automatique n'est appliquée aux fichiers déjà stockés dans S3). Deux scripts (indépendants, ordre indifférent) :

```bash
cd scripts
pip install -r requirements.txt

# Ajoute requireRosterValidation (false) et rosterStatus ("created" par équipe) si absents.
python3 migrate_add_roster_validation.py --bucket <nom-du-data-bucket> --dry-run
python3 migrate_add_roster_validation.py --bucket <nom-du-data-bucket>

# Ajoute mode ("ladder"), roundCount (null), rounds ([]) et round (null par défi) si absents.
# Nécessaire (pas juste cosmétique) : sans ça, certains endpoints (inscription, défi) plantent
# sur les tournois créés avant l'ajout des formats suisses, car ils lisent ces champs sans garde.
python3 migrate_add_tournament_modes.py --bucket <nom-du-data-bucket> --dry-run
python3 migrate_add_tournament_modes.py --bucket <nom-du-data-bucket>
```

Le nom du bucket de données est dans la sortie `DataBucketName` du stack CDK :

```bash
aws cloudformation describe-stacks --stack-name BbTournamentStack \
  --query "Stacks[0].Outputs[?OutputKey=='DataBucketName'].OutputValue" --output text
```

Les deux scripts sont idempotents (relançables sans risque) et utilisent une écriture conditionnelle (`If-Match`
sur l'ETag) : si un tournoi est modifié par l'app entre la lecture et l'écriture, cette écriture est ignorée avec
un avertissement plutôt que d'écraser le changement concurrent — il suffit de relancer le script pour la reprendre.

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
