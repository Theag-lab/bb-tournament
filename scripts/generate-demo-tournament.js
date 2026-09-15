#!/usr/bin/env node
/**
 * Generates a static Tournament JSON fixture (pseudo-named coaches, swiss mode, 5 rounds planned)
 * for demo/screenshot/performance-testing purposes. Does NOT write to S3 or call any API — this
 * only produces a local JSON file matching the exact `Tournament` shape from shared/src/types.ts.
 * Reuses the real scoring/standings/pairing logic from the built shared package so the generated
 * data is internally consistent with what the app itself would produce.
 *
 * Supports both tournament formats:
 *  - 'team' (default): teams grouped into squads of 5, double-swiss pairing (squad-level then
 *    rank-matched within the pair).
 *  - 'individual': no squads, plain swiss pairing directly on individual standings.
 *
 * Rounds 1..roundsFullyComplete are fully completed. The next round is deliberately "in
 * progress" — a realistic mix of completed, awaiting_confirmation (one side submitted) and
 * not-yet-played matches — and is the last round generated: exactly like the real app, the round
 * after it can't be generated until this one is fully completed, so it deliberately does not
 * exist yet in this fixture.
 *
 * Usage: node scripts/generate-demo-tournament.js [output-path] [tournament-id] [format] [teamCount] [roundsFullyComplete]
 *   format: 'team' (default) or 'individual'
 *   teamCount: number of teams to generate (default 50)
 *   roundsFullyComplete: how many rounds are fully played before the "in progress" one (default 2)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  RACES,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_ROUND_TIMER,
  DEFAULT_SQUAD_SCORING,
  computeMatchScore,
  computeStandings,
  computeSquadStandings,
} = require('../shared/dist');

const FORMAT = process.argv[4] || 'team';
if (FORMAT !== 'team' && FORMAT !== 'individual') {
  console.error(`Format invalide : "${FORMAT}" (attendu : "team" ou "individual")`);
  process.exit(1);
}
const outputPath = path.resolve(
  process.cwd(),
  process.argv[2] || (FORMAT === 'individual' ? 'scripts/demo-indiv-tournament.json' : 'scripts/demo-tournament.json')
);
const TOURNAMENT_ID = process.argv[3] || (FORMAT === 'individual' ? 'demo-indiv' : 'tournoi-demo');
const TEAM_COUNT = process.argv[5] ? parseInt(process.argv[5], 10) : 50;
const ROUNDS_FULLY_COMPLETE = process.argv[6] ? parseInt(process.argv[6], 10) : 2; // rounds 1..N: launched + all matches completed
const TEAM_PASSWORD = 'demo1234';
const SQUAD_SIZE = 5;
const SQUAD_COUNT = Math.max(2, Math.ceil(TEAM_COUNT / SQUAD_SIZE));
const ROUND_COUNT = 5;
// Round 3 ("en cours"): each match randomly lands in one of these three real-world states.
const ROUND3_COMPLETED_SHARE = 0.4;
const ROUND3_AWAITING_SHARE = 0.3;
// remainder (~0.3) stays 'accepted' with no result at all — not played yet

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

// Blood Bowl-flavored coach handles, not "real names" — the community convention.
const COACH_PSEUDOS = [
  'TitanRouge', 'CrocMalin', 'FurieVerte', "L-Ecorcheur", 'MisterSplat', 'GrosBill', 'SangFroid',
  'CasseOs', 'Ratichon', 'Frappadingue', 'Belourdo', 'TataViolente', 'PapyCogneur', 'LaTornade',
  'DocteurDoom', 'CaptainCrash', 'MamanOurs', 'LeBoucherDuCoin', 'ZigZagBoy', "L-Insaisissable",
  'TontonPatate', 'VladLeFol', 'MissDropKick', 'LeCafardFou', 'GroPoing', 'SirPlaquage',
  'LadyCarnage', 'PetitPoulet', 'GrandChelem', 'LeFacteurFou', 'BabaCool', 'TontonFlingueur',
  'DameDeFer', 'MonstreDuLundi', 'CoachChaos', 'LordSplat', 'LaBrute38', 'SkullCrusher',
  'MamieRafale', 'PapaOgre', 'LeRequinBlanc', "L-Ombre", 'TitiTerreur', 'FouFurieux',
  'MisterMeeple', 'LaGriffe', 'DocSavage', 'CaptainClutch', 'LordDesOs', 'ReineDesCasse',
  'MonsieurMuscle', 'PitBullDu92', 'TatieCatastrophe', 'LeVengeur', 'NainDeChoc', 'RoiDuFoul',
  'DameDuChaos', 'BrutalBob', 'LaMachine', 'SuperCoach', 'AgentOrange',
];
const SQUAD_NAMES = [
  'Les Lanceurs de Pow', 'Les Blitzeurs Fous', 'Les Rois du Foul', 'Les Seigneurs du Turnover',
  'Les Maitres du Crowdsurf', 'Les Marchands de Cases', 'Les Comptables du KO',
  'Les Artisans du Splat', 'Les Poetes du Placage', 'Les Douaniers du Chaos',
];
const TEAM_ADJ = [
  'Fous', 'Enrages', 'Sanglants', 'Maudits', 'Implacables', 'Rugissants', 'Vicieux', 'Increvables',
  'Ecrasants', 'Furieux', 'Sauvages', 'Redoutables',
];
const TEAM_NOUN = [
  'Bouchers', 'Titans', 'Gobelins', 'Dents-de-sabre', 'Tornades', 'Marteaux', 'Charognards',
  'Berserkers', 'Colosses', 'Faucheurs', 'Spectres', 'Golems',
];

/**
 * Draws `count` unique labels from `pool`, shuffled. When `count` exceeds the pool size (e.g. a
 * 200-team fixture drawing from ~60 coach pseudos), cycles back through the shuffled pool with an
 * incrementing " 2", " 3", ... suffix rather than silently truncating or looping forever.
 */
function uniqueFromPool(count, pool) {
  const shuffled = shuffle(pool);
  const out = [];
  for (let i = 0; i < count; i++) {
    const cycle = Math.floor(i / shuffled.length);
    const base = shuffled[i % shuffled.length];
    out.push(cycle === 0 ? base : `${base} ${cycle + 1}`);
  }
  return out;
}

function uniqueTeamNames(count) {
  const combos = [];
  for (const adj of TEAM_ADJ) {
    for (const noun of TEAM_NOUN) {
      combos.push(`Les ${adj} ${noun}`);
    }
  }
  return uniqueFromPool(count, combos);
}

const now = new Date();
const isoDaysAgo = (days) => new Date(now.getTime() - days * 86400000).toISOString();
const dateDaysAgo = (days) => isoDaysAgo(days).slice(0, 10);

// ---- Squads (team format only) ----
const squads =
  FORMAT === 'team'
    ? uniqueFromPool(SQUAD_COUNT, SQUAD_NAMES).map((name) => ({
        id: uuid(),
        name,
        createdAt: isoDaysAgo(30),
      }))
    : [];

// ---- Teams ----
const coachNames = uniqueFromPool(TEAM_COUNT, COACH_PSEUDOS);
const teamNames = uniqueTeamNames(TEAM_COUNT);
const teams = [];
for (let i = 0; i < TEAM_COUNT; i++) {
  const squad = FORMAT === 'team' ? squads[Math.floor(i / SQUAD_SIZE) % squads.length] : null;
  teams.push({
    id: uuid(),
    password: TEAM_PASSWORD,
    name: teamNames[i],
    coachName: coachNames[i],
    race: RACES[i % RACES.length],
    nafNumber: rand() < 0.6 ? String(randint(10000, 89999)) : null,
    squadId: squad ? squad.id : null,
    poolId: null,
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

function fabricateScore(playedAt, team1Id, team2Id) {
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
  return computeMatchScore(input, team1Id, team2Id, DEFAULT_INDIVIDUAL_SCORING);
}

/** A fully completed match: both sides confirmed. */
function completedResult(playedAt, team1Id, team2Id) {
  const score = fabricateScore(playedAt, team1Id, team2Id);
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

/** One side submitted a result, the other hasn't confirmed it yet. */
function awaitingConfirmationResult(playedAt, team1Id, team2Id) {
  const score = fabricateScore(playedAt, team1Id, team2Id);
  const submittedAt = new Date(`${playedAt}T20:00:00.000Z`).toISOString();
  return {
    ...score,
    playedAt,
    concededByTeamId: null,
    submittedByTeamId: team1Id,
    submittedAt,
    confirmedByTeamId: null,
    completedAt: null,
  };
}

// ---- Rounds: double-swiss pairing (squad-level, then rank-matched within the pair) ----
const teamSquad = new Map(teams.map((t) => [t.id, t.squadId]));
const challenges = [];
const rounds = [];
const IN_PROGRESS_ROUND = ROUNDS_FULLY_COMPLETE + 1;

function generateRoundMatches(pairs, roundNumber) {
  const isFullyPlayed = roundNumber <= ROUNDS_FULLY_COMPLETE;
  const isInProgress = roundNumber === IN_PROGRESS_ROUND;
  const roundAgeDays = (IN_PROGRESS_ROUND - roundNumber) * 7; // round 3 ("now") = 0 days ago

  for (const [team1Id, team2Id] of pairs) {
    const createdAt = isoDaysAgo(roundAgeDays + 2);
    let status = 'accepted';
    let result = null;

    if (isFullyPlayed) {
      const playedAt = dateDaysAgo(roundAgeDays);
      status = 'completed';
      result = completedResult(playedAt, team1Id, team2Id);
    } else if (isInProgress) {
      const playedAt = dateDaysAgo(randint(0, 2));
      const roll = rand();
      if (roll < ROUND3_COMPLETED_SHARE) {
        status = 'completed';
        result = completedResult(playedAt, team1Id, team2Id);
      } else if (roll < ROUND3_COMPLETED_SHARE + ROUND3_AWAITING_SHARE) {
        status = 'awaiting_confirmation';
        result = awaitingConfirmationResult(playedAt, team1Id, team2Id);
      } // else: stays 'accepted', result null — not played yet
    }

    challenges.push({
      id: uuid(),
      team1Id,
      team2Id,
      status,
      round: roundNumber,
      createdAt,
      updatedAt: result ? result.completedAt || result.submittedAt : createdAt,
      result,
    });
  }
}

for (let roundNumber = 1; roundNumber <= IN_PROGRESS_ROUND; roundNumber++) {
  const individualOrder =
    roundNumber === 1
      ? shuffle(teams.map((t) => t.id))
      : computeStandings(teams, challenges, DEFAULT_INDIVIDUAL_SCORING).map((s) => s.teamId);

  if (FORMAT === 'team') {
    const priorSquadOpponents = buildPriorOpponents(challenges, (teamId) => teamSquad.get(teamId));
    const squadOrder =
      roundNumber === 1
        ? shuffle(squads.map((s) => s.id))
        : computeSquadStandings(squads, teams, challenges, DEFAULT_SQUAD_SCORING).map((s) => s.squadId);
    const squadPairs = pairInOrder(squadOrder, priorSquadOpponents);

    const pairs = [];
    for (const [squadA, squadB] of squadPairs) {
      const membersA = individualOrder.filter((id) => teamSquad.get(id) === squadA);
      const membersB = individualOrder.filter((id) => teamSquad.get(id) === squadB);
      const pairCount = Math.min(membersA.length, membersB.length);
      for (let i = 0; i < pairCount; i++) {
        pairs.push([membersA[i], membersB[i]]);
      }
    }
    generateRoundMatches(pairs, roundNumber);
  } else {
    // Plain swiss pairing directly on individual standings — no squad grouping.
    const priorOpponents = buildPriorOpponents(challenges, (teamId) => teamId);
    const pairs = pairInOrder(individualOrder, priorOpponents);
    generateRoundMatches(pairs, roundNumber);
  }

  // Every generated round has been launched (coaches need it launched to submit results) —
  // including round 3, which is why it can be "in progress" at all.
  rounds.push({ number: roundNumber, status: 'launched' });
}

// ---- Tournament ----
const description =
  FORMAT === 'team'
    ? "# Coupe Francophone de Demo 2026\n\n" +
      "Tournoi de demonstration genere automatiquement (donnees fictives) pour tester l'affichage " +
      `du site : ${TEAM_COUNT} coachs repartis en ${SQUAD_COUNT} escouades de ${SQUAD_SIZE}, format NAF World Cup.\n\n` +
      "## Reglement\n\n- Matchs en 1 mi-temps courte, table maison\n- Casting NAF standard\n- " +
      "Concession forcee a 3-0 en faveur de l'adversaire\n"
    : "# Coupe Francophone de Demo 2026\n\n" +
      "Tournoi de demonstration genere automatiquement (donnees fictives) pour tester l'affichage " +
      `du site : ${TEAM_COUNT} coachs en ronde suisse individuelle.\n\n` +
      "## Reglement\n\n- Matchs en 1 mi-temps courte, table maison\n- Casting NAF standard\n- " +
      "Concession forcee a 3-0 en faveur de l'adversaire\n";

const tournament = {
  id: TOURNAMENT_ID,
  name: FORMAT === 'team' ? 'Coupe Francophone de Demo 2026' : 'Coupe Francophone de Demo 2026 (Individuel)',
  description,
  organizerCoachName: 'CoachOrganisateur',
  requireRosterValidation: false,
  requireResultConfirmation: true,
  showTeamNames: true,
  mode: 'swiss',
  roundCount: ROUND_COUNT,
  rounds,
  format: FORMAT,
  squadSize: FORMAT === 'team' ? SQUAD_SIZE : null,
  squadScoring: FORMAT === 'team' ? DEFAULT_SQUAD_SCORING : null,
  squads,
  poolSize: null,
  poolRoundCount: null,
  qualifiersPerPool: null,
  pools: [],
  knockoutSeeds: null,
  individualScoring: DEFAULT_INDIVIDUAL_SCORING,
  roundTimer: DEFAULT_ROUND_TIMER,
  adminToken: uuid(),
  createdAt: isoDaysAgo(30),
  teams,
  challenges,
};

fs.writeFileSync(outputPath, JSON.stringify(tournament, null, 2) + '\n');

const round3 = challenges.filter((c) => c.round === IN_PROGRESS_ROUND);
console.log(`Ecrit : ${outputPath}`);
console.log(`Tournament id : ${tournament.id}`);
console.log(`Admin token   : ${tournament.adminToken}`);
console.log(`Mot de passe (toutes les equipes) : ${TEAM_PASSWORD}`);
console.log(`${teams.length} equipes, ${squads.length} escouades, ${rounds.length} rondes generees (ronde ${IN_PROGRESS_ROUND} en cours).`);
console.log(
  `Ronde ${IN_PROGRESS_ROUND} : ${round3.filter((c) => c.status === 'completed').length} terminee(s), ` +
    `${round3.filter((c) => c.status === 'awaiting_confirmation').length} en attente de confirmation, ` +
    `${round3.filter((c) => c.status === 'accepted').length} pas encore jouee(s).`
);
