import { v4 as uuidv4 } from 'uuid';
import {
  Challenge,
  DEFAULT_INDIVIDUAL_SCORING,
  Tournament,
  buildKnockoutSeeds,
  computeByeCount,
  computeStandings,
  getKnockoutWinner,
  pairFirstKnockoutRound,
  type BracketByeView,
  type BracketMatchView,
  type BracketRoundView,
  type PoolQualifiers,
} from '@bb-tournament/shared';
import { badRequest, forbidden } from './errors';
import { assertPreviousRoundComplete, buildPriorOpponents, pairInOrder, shuffle } from './pairing';

/**
 * Pool-phase round: each pool runs its own independent mini-swiss (scoped standings + pairing),
 * exactly like `generateNextTeamRound`'s per-squad pairing but flat (no squad-vs-squad matchup,
 * just direct pairing within the pool). An odd pool size leaves one team without a match that
 * round — same implicit-bye precedent already established for uneven squads, no compensating points.
 */
function generatePoolPhaseRound(t: Tournament, roundNumber: number): void {
  const unassigned = t.teams.find((tm) => tm.poolId === null);
  if (unassigned) {
    throw forbidden(`L'équipe "${unassigned.name}" n'est affectée à aucune poule`, 'team_not_in_pool');
  }

  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  const priorOpponents = buildPriorOpponents(t.challenges);
  const config = t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING;
  const newChallenges: Challenge[] = [];

  for (const pool of t.pools) {
    const poolTeams = t.teams.filter((tm) => tm.poolId === pool.id);
    if (poolTeams.length < 2) continue;
    const order =
      roundNumber > 1
        ? computeStandings(poolTeams, t.challenges, config).map((s) => s.teamId)
        : shuffle(poolTeams.map((tm) => tm.id));
    const pairs = pairInOrder(order, priorOpponents);
    for (const [team1Id, team2Id] of pairs) {
      newChallenges.push({
        id: uuidv4(),
        team1Id,
        team2Id,
        status: 'accepted',
        round: roundNumber,
        createdAt: now,
        updatedAt: now,
        result: null,
      });
    }
  }

  t.challenges.push(...newChallenges);
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

/**
 * Transitions a 'pools_knockout' tournament from the pool phase to the knockout phase: validates
 * every pool round is generated and complete, computes each pool's qualifiers (top
 * `qualifiersPerPool` of its scoped standings), builds the cross-pool seed order and first-round
 * pairing (see shared/src/bracket.ts), and creates that round's challenges. `t.knockoutSeeds`
 * being non-null afterward is the sole "knockout phase started" flag — see the Tournament doc
 * comment.
 */
export function launchKnockoutPhase(t: Tournament): void {
  if (t.poolRoundCount === null || t.qualifiersPerPool === null) {
    throw forbidden('Pool phase is not configured for this tournament');
  }
  if (t.knockoutSeeds !== null) {
    throw forbidden('La phase finale a déjà été lancée', 'knockout_already_launched');
  }
  if (t.pools.length === 0) throw badRequest('Les poules n\'ont pas encore été générées');
  if (t.rounds.length < t.poolRoundCount) {
    throw forbidden('Toutes les rondes de poule n\'ont pas encore été générées', 'pool_phase_incomplete');
  }
  const poolChallenges = t.challenges.filter((c) => c.round !== null && c.round <= t.poolRoundCount!);
  if (!poolChallenges.every((c) => c.status === 'completed')) {
    throw forbidden('Certains matchs de poule ne sont pas encore terminés', 'pool_phase_incomplete');
  }

  const config = t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING;
  const poolQualifiers: PoolQualifiers[] = [];
  const poolOfTeam = new Map<string, string>();

  for (const pool of t.pools) {
    const poolTeams = t.teams.filter((tm) => tm.poolId === pool.id);
    if (poolTeams.length < t.qualifiersPerPool!) {
      throw forbidden(
        `La poule "${pool.name}" ne compte que ${poolTeams.length} équipe(s), impossible d'en qualifier ${t.qualifiersPerPool}`,
        'pool_too_small'
      );
    }
    const ranked = computeStandings(poolTeams, t.challenges, config).map((s) => s.teamId);
    poolQualifiers.push({ poolId: pool.id, teamIds: ranked.slice(0, t.qualifiersPerPool!) });
    for (const team of poolTeams) poolOfTeam.set(team.id, pool.id);
  }

  const seeds = buildKnockoutSeeds(poolQualifiers);
  if (seeds.length < 2) {
    throw forbidden('Pas assez de qualifiés pour lancer une phase finale', 'not_enough_qualifiers');
  }

  const { pairs } = pairFirstKnockoutRound(seeds, poolOfTeam);
  const roundNumber = t.poolRoundCount! + 1;
  const now = new Date().toISOString();
  const newChallenges: Challenge[] = pairs.map(([team1Id, team2Id]) => ({
    id: uuidv4(),
    team1Id,
    team2Id,
    status: 'accepted',
    round: roundNumber,
    createdAt: now,
    updatedAt: now,
    result: null,
  }));

  t.knockoutSeeds = seeds;
  t.challenges.push(...newChallenges);
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

/**
 * Generates a knockout round after the first one (which `launchKnockoutPhase` creates). The
 * "advancing" list for the round right after the first knockout round is byes (recomputed
 * on-demand from `knockoutSeeds` — never persisted) followed by that round's winners; every round
 * after that is just the previous round's winners, in `t.challenges` insertion order (stable even
 * across an admin swap, which only mutates `team2Id`). Consecutive advancers are paired (0-1,
 * 2-3, ...).
 */
function generateKnockoutRound(t: Tournament, roundNumber: number): void {
  assertPreviousRoundComplete(t, roundNumber);
  const previousRoundNumber = roundNumber - 1;
  const config = t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING;
  const prevChallenges = t.challenges.filter((c) => c.round === previousRoundNumber);
  const winners = prevChallenges.map((c) => getKnockoutWinner(c.result!, c.team1Id, c.team2Id, config.tiebreakers, t.challenges));

  let advancing: string[];
  if (previousRoundNumber === t.poolRoundCount! + 1) {
    const byeCount = computeByeCount(t.knockoutSeeds!.length);
    advancing = [...t.knockoutSeeds!.slice(0, byeCount), ...winners];
  } else {
    advancing = winners;
  }

  if (advancing.length < 2) {
    throw forbidden('Le tableau final est déjà terminé — un vainqueur a été désigné', 'knockout_complete');
  }

  const now = new Date().toISOString();
  const newChallenges: Challenge[] = [];
  for (let i = 0; i < advancing.length; i += 2) {
    newChallenges.push({
      id: uuidv4(),
      team1Id: advancing[i],
      team2Id: advancing[i + 1],
      status: 'accepted',
      round: roundNumber,
      createdAt: now,
      updatedAt: now,
      result: null,
    });
  }

  t.challenges.push(...newChallenges);
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

/** Entry point called from `generateNextRound` for 'pools_knockout' tournaments. */
export function generateNextPoolsKnockoutRound(t: Tournament): void {
  if (t.poolRoundCount === null) throw forbidden('poolRoundCount is not configured for this tournament');
  if (t.pools.length === 0) throw badRequest('Les poules n\'ont pas encore été générées');

  const roundNumber = t.rounds.length + 1;
  if (roundNumber <= t.poolRoundCount) {
    generatePoolPhaseRound(t, roundNumber);
    return;
  }
  if (t.knockoutSeeds === null) {
    throw forbidden("La phase finale n'a pas encore été lancée", 'knockout_not_launched');
  }
  generateKnockoutRound(t, roundNumber);
}

/**
 * Builds the public bracket view: one entry per knockout round already generated so far (rounds
 * not yet generated are simply absent — this is what makes the graph render progressively rather
 * than as a pre-built skeleton). Returns null before the knockout phase has been launched.
 */
export function buildBracketView(t: Tournament): BracketRoundView[] | null {
  if (t.mode !== 'pools_knockout' || t.knockoutSeeds === null || t.poolRoundCount === null) return null;
  const config = t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING;
  const firstKnockoutRound = t.poolRoundCount + 1;
  const knockoutRounds = t.rounds.filter((r) => r.number >= firstKnockoutRound).sort((a, b) => a.number - b.number);

  return knockoutRounds.map((round) => {
    let position = 0;
    const byes: BracketByeView[] = [];
    if (round.number === firstKnockoutRound) {
      const byeCount = computeByeCount(t.knockoutSeeds!.length);
      for (const teamId of t.knockoutSeeds!.slice(0, byeCount)) {
        byes.push({ position: position++, teamId });
      }
    }
    const matches: BracketMatchView[] = t.challenges
      .filter((c) => c.round === round.number)
      .map((c) => ({
        challengeId: c.id,
        position: position++,
        team1Id: c.team1Id,
        team2Id: c.team2Id,
        winnerTeamId:
          c.status === 'completed' && c.result
            ? getKnockoutWinner(c.result, c.team1Id, c.team2Id, config.tiebreakers, t.challenges)
            : null,
      }));
    return { roundNumber: round.number, matches, byes };
  });
}

/** The overall tournament winner, once the final knockout round's single match is completed. */
export function getKnockoutChampion(bracket: BracketRoundView[] | null): string | null {
  if (!bracket || bracket.length === 0) return null;
  const last = bracket[bracket.length - 1];
  if (last.byes.length !== 0 || last.matches.length !== 1) return null;
  return last.matches[0].winnerTeamId;
}
