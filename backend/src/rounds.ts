import { v4 as uuidv4 } from 'uuid';
import { Challenge, Tournament, computeStandings } from '@bb-tournament/shared';
import { badRequest, forbidden, notFound } from './errors';

// Statuses that mean "this pre-round challenge represents a real commitment" — used when
// reconciling round 1 for swiss_with_challenge: anything less than 'accepted' never happened.
const LOCKED_IN_STATUSES = new Set(['accepted', 'awaiting_confirmation', 'completed']);

function shuffle<T>(items: T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildPriorOpponents(challenges: Challenge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
  };
  for (const ch of challenges) {
    if (ch.status !== 'completed') continue;
    add(ch.team1Id, ch.team2Id);
    add(ch.team2Id, ch.team1Id);
  }
  return map;
}

/** Pairs teams in the given order, walking forward and preferring an opponent not already played. */
function pairInOrder(orderedIds: string[], priorOpponents: Map<string, Set<string>>): [string, string][] {
  const pairs: [string, string][] = [];
  const used = new Set<string>();
  for (let i = 0; i < orderedIds.length; i++) {
    const a = orderedIds[i];
    if (used.has(a)) continue;
    used.add(a);

    let opponent: string | null = null;
    for (let j = i + 1; j < orderedIds.length; j++) {
      const b = orderedIds[j];
      if (used.has(b)) continue;
      if (!priorOpponents.get(a)?.has(b)) {
        opponent = b;
        break;
      }
    }
    if (!opponent) {
      // No rematch-free opponent left: fall back to the nearest unused team.
      for (let j = i + 1; j < orderedIds.length; j++) {
        const b = orderedIds[j];
        if (!used.has(b)) {
          opponent = b;
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

/**
 * Generates the next round's pairings and appends them to the tournament (mutates in place).
 * Round 1 pairs are random (except pre-locked challenges in swiss_with_challenge mode); rounds
 * 2+ pair teams adjacent in the current standings, avoiding rematches where possible.
 */
export function generateNextRound(t: Tournament): void {
  if (t.mode === 'ladder') throw forbidden('This tournament has no rounds (ladder mode)');
  if (t.roundCount === null) throw forbidden('roundCount is not configured for this tournament');
  if (t.rounds.length >= t.roundCount) throw forbidden('All rounds have already been generated', 'all_rounds_generated');
  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.teams.length % 2 !== 0) {
    throw forbidden('An odd number of teams cannot be paired; wait for another team to register', 'odd_team_count');
  }

  const roundNumber = t.rounds.length + 1;

  if (roundNumber > 1) {
    const previousRoundNumber = t.rounds[t.rounds.length - 1].number;
    const previousChallenges = t.challenges.filter((c) => c.round === previousRoundNumber);
    if (!previousChallenges.every((c) => c.status === 'completed')) {
      throw forbidden(`Round ${previousRoundNumber} is not finished yet`, 'previous_round_unfinished');
    }
  }

  const now = new Date().toISOString();
  const lockedTeamIds = new Set<string>();

  if (roundNumber === 1 && t.mode === 'swiss_with_challenge') {
    // Lock in pre-round free challenges that reached at least "accepted" as round-1 matches.
    for (const ch of t.challenges) {
      if (ch.round !== null || !LOCKED_IN_STATUSES.has(ch.status)) continue;
      if (lockedTeamIds.has(ch.team1Id) || lockedTeamIds.has(ch.team2Id)) continue; // defensive
      ch.round = 1;
      ch.updatedAt = now;
      lockedTeamIds.add(ch.team1Id);
      lockedTeamIds.add(ch.team2Id);
    }
    // Any still-pending free challenge didn't make it into round 1 — drop it.
    for (const ch of t.challenges) {
      if (ch.round === null && ch.status === 'pending') {
        ch.status = 'cancelled';
        ch.updatedAt = now;
      }
    }
  }

  const priorOpponents = buildPriorOpponents(t.challenges);
  let candidateIds = t.teams.map((tm) => tm.id).filter((id) => !lockedTeamIds.has(id));
  candidateIds =
    roundNumber > 1
      ? computeStandings(t.teams, t.challenges)
          .map((s) => s.teamId)
          .filter((id) => !lockedTeamIds.has(id))
      : shuffle(candidateIds);

  const pairs = pairInOrder(candidateIds, priorOpponents);

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

  t.challenges.push(...newChallenges);
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

/** Swaps the "away" team between two draft-round matches (reassigns their opponents). */
export function swapRoundMatches(t: Tournament, roundNumber: number, matchId1: string, matchId2: string): void {
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (!round) throw notFound('Round not found');
  if (round.status !== 'draft') throw forbidden('Only a draft round can be edited', 'round_not_draft');
  if (matchId1 === matchId2) throw badRequest('Cannot swap a match with itself');

  const m1 = t.challenges.find((c) => c.id === matchId1 && c.round === roundNumber);
  const m2 = t.challenges.find((c) => c.id === matchId2 && c.round === roundNumber);
  if (!m1 || !m2) throw notFound('Match not found in this round');
  if (m1.team1Id === m2.team2Id || m2.team1Id === m1.team2Id) {
    throw badRequest('This swap would pit a team against itself');
  }

  const now = new Date().toISOString();
  const tmp = m1.team2Id;
  m1.team2Id = m2.team2Id;
  m2.team2Id = tmp;
  m1.updatedAt = now;
  m2.updatedAt = now;
}

export function launchRound(t: Tournament, roundNumber: number): void {
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (!round) throw notFound('Round not found');
  if (round.status === 'launched') throw forbidden('Round already launched', 'round_already_launched');
  round.status = 'launched';
}
