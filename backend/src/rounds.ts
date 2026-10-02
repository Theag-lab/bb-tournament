import { v4 as uuidv4 } from 'uuid';
import {
  Challenge,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_SQUAD_SCORING,
  Tournament,
  computeSquadStandings,
  computeStandings,
} from '@bb-tournament/shared';
import { badRequest, forbidden, notFound } from './errors';
import { assertPreviousRoundComplete, buildPriorOpponents, pairInOrder, shuffle } from './pairing';
import { generateNextPoolsKnockoutRound } from './bracket';

// Statuses that mean "this pre-round challenge represents a real commitment" — used when
// reconciling round 1 for swiss_with_challenge: anything less than 'accepted' never happened.
const LOCKED_IN_STATUSES = new Set(['accepted', 'awaiting_confirmation', 'completed']);

/**
 * Generates the next round's pairings and appends them to the tournament (mutates in place).
 * Round 1 pairs are random (except pre-locked challenges in swiss_with_challenge mode); rounds
 * 2+ pair teams adjacent in the current standings, avoiding rematches where possible.
 */
export function generateNextRound(t: Tournament): void {
  if (t.mode === 'ladder') throw forbidden('This tournament has no rounds (ladder mode)');
  if (t.mode === 'pools_knockout') {
    generateNextPoolsKnockoutRound(t);
    return;
  }
  if (t.roundCount === null) throw forbidden('roundCount is not configured for this tournament');
  if (t.rounds.length >= t.roundCount) throw forbidden('All rounds have already been generated', 'all_rounds_generated');

  if (t.format === 'team') {
    generateNextTeamRound(t);
    return;
  }

  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.teams.length % 2 !== 0) {
    throw forbidden('An odd number of teams cannot be paired; wait for another team to register', 'odd_team_count');
  }

  const roundNumber = t.rounds.length + 1;
  assertPreviousRoundComplete(t, roundNumber);

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
      ? computeStandings(t.teams, t.challenges, t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, t.customStatCategories ?? [])
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

/** Squad-level equivalent of buildPriorOpponents: two squads are "already faced" once any pair of their members has completed a match. */
function buildPriorSquadOpponents(challenges: Challenge[], teamSquad: Map<string, string | null>): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a)!.add(b);
  };
  for (const ch of challenges) {
    if (ch.status !== 'completed') continue;
    const squadA = teamSquad.get(ch.team1Id);
    const squadB = teamSquad.get(ch.team2Id);
    if (!squadA || !squadB || squadA === squadB) continue;
    add(squadA, squadB);
    add(squadB, squadA);
  }
  return map;
}

/**
 * Double-swiss pairing for 'team' format tournaments: squads are paired like teams are in the
 * individual algorithm above (adjacent in squad standings, avoiding squad-level rematches via
 * the same `pairInOrder`), then within each squad pairing, members are matched by their
 * individual rank inside their own squad (1st vs 1st, 2nd vs 2nd, ...) — no individual-level
 * rematch avoidance, squad-level avoidance is considered sufficient (confirmed with the
 * organiser). Uneven squad sizes leave the extra lower-ranked members without a match that round
 * (implicit bye, no challenge created for them).
 */
function generateNextTeamRound(t: Tournament): void {
  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.squads.length === 0) throw badRequest('No squads registered yet');
  if (t.squads.length % 2 !== 0) {
    throw forbidden('An odd number of squads cannot be paired; wait for another squad to register', 'odd_squad_count');
  }
  const emptySquad = t.squads.find((s) => !t.teams.some((tm) => tm.squadId === s.id));
  if (emptySquad) {
    throw forbidden(`Squad "${emptySquad.name}" has no members yet`, 'empty_squad');
  }

  const roundNumber = t.rounds.length + 1;
  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  const teamSquad = new Map(t.teams.map((tm) => [tm.id, tm.squadId]));
  const scoring = t.squadScoring ?? DEFAULT_SQUAD_SCORING;

  const priorSquadOpponents = buildPriorSquadOpponents(t.challenges, teamSquad);
  const squadOrder = computeSquadStandings(t.squads, t.teams, t.challenges, scoring).map((s) => s.squadId);
  const squadPairs = pairInOrder(squadOrder, priorSquadOpponents);

  const individualOrder = computeStandings(
    t.teams,
    t.challenges,
    t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
    t.customStatCategories ?? []
  ).map((s) => s.teamId);

  const newChallenges: Challenge[] = [];
  for (const [squadA, squadB] of squadPairs) {
    const membersA = individualOrder.filter((id) => teamSquad.get(id) === squadA);
    const membersB = individualOrder.filter((id) => teamSquad.get(id) === squadB);
    const pairCount = Math.min(membersA.length, membersB.length);
    for (let i = 0; i < pairCount; i++) {
      newChallenges.push({
        id: uuidv4(),
        team1Id: membersA[i],
        team2Id: membersB[i],
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
 * Pits `teamId1` against `teamId2` in a draft round — picking any two coaches, regardless of
 * which match or which side (home/away) they're currently on, not just the "away" slot of two
 * whole matches. Their former opponents are freed up by the same move and end up paired with each
 * other, so exactly two matches change and no team is left without an opponent.
 */
export function swapRoundMatches(t: Tournament, roundNumber: number, teamId1: string, teamId2: string): void {
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (!round) throw notFound('Round not found');
  if (round.status !== 'draft') throw forbidden('Only a draft round can be edited', 'round_not_draft');
  if (teamId1 === teamId2) throw badRequest('Cannot pair a coach against themselves');

  const findMatch = (teamId: string) =>
    t.challenges.find((c) => c.round === roundNumber && (c.team1Id === teamId || c.team2Id === teamId));
  const match1 = findMatch(teamId1);
  const match2 = findMatch(teamId2);
  if (!match1 || !match2) throw notFound('Coach not found in this round');
  if (match1.id === match2.id) throw badRequest('These two coaches are already playing each other');

  const opponentOf = (match: Challenge, teamId: string) => (match.team1Id === teamId ? match.team2Id : match.team1Id);
  const opp1 = opponentOf(match1, teamId1); // freed up by teamId1 leaving to face teamId2
  const opp2 = opponentOf(match2, teamId2); // freed up by teamId2 leaving to face teamId1, ends up facing opp1

  if (t.format === 'team') {
    const squadOf = (teamId: string) => t.teams.find((tm) => tm.id === teamId)?.squadId ?? null;
    const sameSquad = (a: string, b: string) => squadOf(a) === squadOf(b);
    if (sameSquad(teamId1, teamId2) || sameSquad(opp1, opp2)) {
      throw forbidden(
        'In team format, this swap would pit two players from the same squad against each other',
        'swap_creates_same_squad_match'
      );
    }
  }

  const now = new Date().toISOString();
  const replaceOpponent = (match: Challenge, oldOpponentId: string, newOpponentId: string) => {
    if (match.team1Id === oldOpponentId) match.team1Id = newOpponentId;
    else match.team2Id = newOpponentId;
    match.updatedAt = now;
  };
  replaceOpponent(match1, opp1, teamId2);
  replaceOpponent(match2, teamId2, opp1);
}

export function launchRound(t: Tournament, roundNumber: number): void {
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (!round) throw notFound('Round not found');
  if (round.status === 'launched') throw forbidden('Round already launched', 'round_already_launched');
  round.status = 'launched';
}

/**
 * Reverts the tournament's LAST launched round back to 'draft' so its pairings can be edited again
 * (see swapRoundMatches, draft-only) — e.g. the admin launched it, then realised two coaches
 * should be swapped. Only ever the last round: an earlier round has later rounds generated from
 * its outcome, so un-launching it would leave those downstream rounds referencing a pairing that's
 * no longer settled. Refuses once any of its matches has a result — the pairing is the only thing
 * this undoes, not played results, and once that round's already being played it's too late to
 * reshuffle it.
 */
export function cancelRoundLaunch(t: Tournament, roundNumber: number): void {
  const lastRound = t.rounds[t.rounds.length - 1];
  if (!lastRound || lastRound.number !== roundNumber) {
    throw forbidden('Only the last round can be cancelled', 'not_last_round');
  }
  if (lastRound.status !== 'launched') {
    throw forbidden('This round is not launched', 'round_not_launched');
  }
  const anyPlayed = t.challenges.some((c) => c.round === roundNumber && c.result !== null);
  if (anyPlayed) {
    throw forbidden('Cannot cancel a round once a match has been played', 'round_already_played');
  }
  lastRound.status = 'draft';
}
