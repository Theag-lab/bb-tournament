#!/usr/bin/env node
/**
 * Generates a static Tournament JSON fixture (team format, 50 coaches in 10 squads, 5 rounds —
 * 3 played, 1 in draft) for demo/screenshot purposes. Does NOT write to S3 or call any API —
 * this only produces a local JSON file matching the exact `Tournament` shape from
 * shared/src/types.ts. Reuses the real scoring/standings/pairing logic from the built shared
 * package so the generated data is internally consistent with what the app itself would produce.
 *
 * Usage: node scripts/generate-demo-tournament.js [output-path] [tournament-id]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  RACES,
  DEFAULT_SQUAD_SCORING,
  computeMatchScore,
  computeStandings,
  computeSquadStandings,
} = require('../shared/dist');

const outputPath = path.resolve(process.cwd(), process.argv[2] || 'scripts/demo-tournament.json');
const TOURNAMENT_ID = process.argv[3] || 'tournoi-demo';
const TEAM_PASSWORD = 'demo1234';
const SQUAD_SIZE = 5;
const SQUAD_COUNT = 10;
const ROUND_COUNT = 5;
const PLAYED_ROUNDS = 3; // rounds 1..3 launched+completed, round 4 generated as draft, round 5 not yet generated

// Deterministic PRNG (mulberry32) so re-running the script produces identical output.
function mulberry32(seed) {
  return function rand() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const uuid = () => crypto.randomUUID();
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const randint = (min, max) => min + Math.floor(rand() * (max - min + 1));

const FIRST_NAMES = [
  'Julien', 'Marc', 'Sophie', 'Thomas', 'Claire', 'Antoine', 'Lea', 'Nicolas', 'Camille', 'Hugo',
  'Manon', 'Louis', 'Chloe', 'Maxime', 'Emma', 'Simon', 'Alice', 'Romain', 'Julie', 'Bastien',
];
const LAST_NAMES = [
  'Dupont', 'Bernard', 'Moreau', 'Lefevre', 'Girard', 'Bonnet', 'Roux', 'Fontaine', 'Rousseau',
  'Vincent', 'Muller', 'Lambert', 'Fournier', 'Robin', 'Faure', 'Blanchard', 'Guerin', 'Boyer',
];
const TEAM_ADJ = [
  'Fous', 'Enrages', 'Sanglants', 'Maudits', 'Implacables', 'Rugissants', 'Vicieux', 'Increvables',
  'Ecrasants', 'Furieux', 'Sauvages', 'Redoutables',
];
const TEAM_NOUN = [
  'Bouchers', 'Titans', 'Gobelins', 'Dents-de-sabre', 'Tornades', 'Marteaux', 'Charognards',
  'Berserkers', 'Colosses', 'Faucheurs', 'Spectres', 'Golems',
];
const SQUAD_NAMES = [
  'France', 'Belgique', 'Suisse', 'Quebec', 'Luxembourg', 'Bretagne', 'Occitanie', 'Normandie',
  'Wallonie', 'Acadie',
];

function uniqueNames(count, pool1, pool2, template) {
  const seen = new Set();
  const out = [];
  while (out.length < count) {
    const candidate = template(pool1[randint(0, pool1.length - 1)], pool2[randint(0, pool2.length - 1)]);
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

const now = new Date();
const isoDaysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
const dateDaysAgo = (days) => isoDaysAgo(days).slice(0, 10);

// ---- Squads ----
const squads = SQUAD_NAMES.slice(0, SQUAD_COUNT).map((name) => ({
  id: uuid(),
  name,
  createdAt: isoDaysAgo(30),
}));

// ---- Teams ----
const coachNames = uniqueNames(50, FIRST_NAMES, LAST_NAMES, (a, b) => `${a} ${b}`);
const teamNames = uniqueNames(50, TEAM_ADJ, TEAM_NOUN, (a, b) => `Les ${a} ${b}`);
const teams = [];
for (let i = 0; i < 50; i++) {
  const squad = squads[Math.floor(i / SQUAD_SIZE) % squads.length];
  teams.push({
    id: uuid(),
    password: TEAM_PASSWORD,
    name: teamNames[i],
    coachName: coachNames[i],
    race: RACES[i % RACES.length],
    nafNumber: rand() < 0.6 ? String(randint(10000, 89999)) : null,
    squadId: squad.id,
    createdAt: isoDaysAgo(29),
    rosterImage: null,
    rosterStatus: 'created',
  });
}

// ---- Pairing helpers (same shape as backend/src/rounds.ts, reimplemented standalone here since
// that module pulls in AWS SDK deps this script doesn't need) ----
function buildPriorOpponents(challenges, keyOf) {
  const map = new Map();
  const add = (a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const ch of challenges) {
    if (ch.status !== 'completed') continue;
    const a = keyOf(ch.team1Id);
    const b = keyOf(ch.team2Id);
    if (!a || !b || a === b) continue;
    add(a, b);
    add(b, a);
  }
  return map;
}

function pairInOrder(orderedIds, priorOpponents) {
  const pairs = [];
  const used = new Set();
  for (let i = 0; i < orderedIds.length; i++) {
    const a = orderedIds[i];
    if (used.has(a)) continue;
    used.add(a);
    let opponent = null;
    for (let j = i + 1; j < orderedIds.length; j++) {
      const b = orderedIds[j];
      if (used.has(b)) continue;
      if (!priorOpponents.get(a)?.has(b)) {
        opponent = b;
        break;
      }
    }
    if (!opponent) {
      for (let j = i + 1; j < orderedIds.length; j++) {
        if (!used.has(orderedIds[j])) {
          opponent = orderedIds[j];
          break;
        }
      }
    }
    if (opponent) {
      used.add(opponent);
      pairs.push([a, opponent]);
    }
  }
  return pairs;
}

function fabricateResult(playedAt, team1Id, team2Id) {
  const input = {
    playedAt,
    team1Td: randint(0, 4),
    team2Td: randint(0, 4),
    team1Cas: randint(0, 3),
    team2Cas: randint(0, 3),
    team1Agg: randint(1, 6),
    team2Agg: randint(1, 6),
    concededByTeamId: null,
  };
  const score = computeMatchScore(input, team1Id, team2Id);
  const submittedAt = new Date(`${playedAt}T18:00:00.000Z`).toISOString();
  return {
    ...score,
    playedAt,
    concededByTeamId: null,
    submittedByTeamId: team1Id,
    submittedAt,
    confirmedByTeamId: team2Id,
    completedAt: submittedAt,
  };
}

// ---- Rounds: double-swiss pairing (squad-level, then rank-matched within the pair) ----
const teamSquad = new Map(teams.map((t) => [t.id, t.squadId]));
const challenges = [];
const rounds = [];

for (let roundNumber = 1; roundNumber <= PLAYED_ROUNDS + 1; roundNumber++) {
  const priorSquadOpponents = buildPriorOpponents(challenges, (teamId) => teamSquad.get(teamId));
  const squadOrder =
    roundNumber === 1
      ? shuffle(squads.map((s) => s.id))
      : computeSquadStandings(squads, teams, challenges, DEFAULT_SQUAD_SCORING).map((s) => s.squadId);
  const squadPairs = pairInOrder(squadOrder, priorSquadOpponents);

  const individualOrder =
    roundNumber === 1 ? shuffle(teams.map((t) => t.id)) : computeStandings(teams, challenges).map((s) => s.teamId);

  const isPlayed = roundNumber <= PLAYED_ROUNDS;
  const playedAt = dateDaysAgo((PLAYED_ROUNDS - roundNumber + 1) * 7);

  for (const [squadA, squadB] of squadPairs) {
    const membersA = individualOrder.filter((id) => teamSquad.get(id) === squadA);
    const membersB = individualOrder.filter((id) => teamSquad.get(id) === squadB);
    const pairCount = Math.min(membersA.length, membersB.length);
    for (let i = 0; i < pairCount; i++) {
      const team1Id = membersA[i];
      const team2Id = membersB[i];
      const createdAt = isoDaysAgo((PLAYED_ROUNDS - roundNumber + 2) * 7);
      challenges.push({
        id: uuid(),
        team1Id,
        team2Id,
        status: isPlayed ? 'completed' : 'accepted',
        round: roundNumber,
        createdAt,
        updatedAt: isPlayed ? new Date(`${playedAt}T18:00:00.000Z`).toISOString() : createdAt,
        result: isPlayed ? fabricateResult(playedAt, team1Id, team2Id) : null,
      });
    }
  }

  rounds.push({ number: roundNumber, status: isPlayed ? 'launched' : 'draft' });
}

// ---- Tournament ----
const tournament = {
  id: TOURNAMENT_ID,
  name: 'Coupe Francophone de Demo 2026',
  description:
    "# Coupe Francophone de Demo 2026\n\n" +
    "Tournoi de demonstration genere automatiquement (donnees fictives) pour tester l'affichage " +
    "du site : 50 coachs repartis en 10 escouades de 5, format NAF World Cup.\n\n" +
    "## Reglement\n\n- Matchs en 1 mi-temps courte, table maison\n- Casting NAF standard\n- " +
    "Concession forcee a 3-0 en faveur de l'adversaire\n",
  requireRosterValidation: false,
  mode: 'swiss',
  roundCount: ROUND_COUNT,
  rounds,
  format: 'team',
  squadSize: SQUAD_SIZE,
  squadScoring: DEFAULT_SQUAD_SCORING,
  squads,
  adminToken: uuid(),
  createdAt: isoDaysAgo(30),
  teams,
  challenges,
};

fs.writeFileSync(outputPath, JSON.stringify(tournament, null, 2) + '\n');

console.log(`Ecrit : ${outputPath}`);
console.log(`Tournament id : ${tournament.id}`);
console.log(`Admin token   : ${tournament.adminToken}`);
console.log(`Mot de passe (toutes les equipes) : ${TEAM_PASSWORD}`);
console.log(`${teams.length} equipes, ${squads.length} escouades, ${challenges.length} matchs (${challenges.filter((c) => c.status === 'completed').length} termines).`);
