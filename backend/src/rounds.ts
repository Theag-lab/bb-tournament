import { v4 as uuidv4 } from 'uuid';
import {
  Challenge,
  RoundInfo,
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

type Pair = [string, string];

const isPair = (pair: Pair, a: string, b: string) => (pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a);

function newMatch(team1Id: string, team2Id: string, roundNumber: number, now: string): Challenge {
  return {
    id: uuidv4(),
    team1Id,
    team2Id,
    status: 'accepted',
    round: roundNumber,
    createdAt: now,
    updatedAt: now,
    result: null,
  };
}

function teamSquadLookup(t: Tournament): (teamId: string) => string | null {
  const teamSquad = new Map(t.teams.map((tm) => [tm.id, tm.squadId]));
  return (teamId) => teamSquad.get(teamId) ?? null;
}

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

  assertTeamsPairable(t);

  const roundNumber = t.rounds.length + 1;
  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  const lockedTeamIds = new Set<string>();
  const fixedChallengeIds: string[] = [];

  if (roundNumber === 1 && t.mode === 'swiss_with_challenge') {
    // Lock in pre-round free challenges that reached at least "accepted" as round-1 matches.
    for (const ch of t.challenges) {
      if (ch.round !== null || !LOCKED_IN_STATUSES.has(ch.status)) continue;
      if (lockedTeamIds.has(ch.team1Id) || lockedTeamIds.has(ch.team2Id)) continue; // defensive
      ch.round = 1;
      ch.updatedAt = now;
      fixedChallengeIds.push(ch.id);
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

  t.challenges.push(...pairs.map(([team1Id, team2Id]) => newMatch(team1Id, team2Id, roundNumber, now)));
  t.rounds.push({ number: roundNumber, status: 'draft', ...(fixedChallengeIds.length ? { fixedChallengeIds } : {}) });
}

function assertTeamsPairable(t: Tournament): void {
  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.teams.length % 2 !== 0) {
    throw forbidden('An odd number of teams cannot be paired; wait for another team to register', 'odd_team_count');
  }
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
 * (implicit bye, no challenge created for them). Round 1 has no standings yet, so both squads and
 * members are drawn at random instead.
 */
function generateNextTeamRound(t: Tournament): void {
  assertSquadsPairable(t);

  const roundNumber = t.rounds.length + 1;
  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  const squadPairs =
    roundNumber === 1
      ? pairInOrder(shuffle(t.squads.map((s) => s.id)), new Map())
      : pairInOrder(
          computeSquadStandings(
            t.squads,
            t.teams,
            t.challenges,
            t.squadScoring ?? DEFAULT_SQUAD_SCORING,
            t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
            t.customStatCategories ?? []
          ).map((s) => s.squadId),
          buildPriorSquadOpponents(t.challenges, new Map(t.teams.map((tm) => [tm.id, tm.squadId])))
        );

  t.challenges.push(...buildSquadPairMatches(t, squadPairs, [], roundNumber, now));
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

function assertSquadsPairable(t: Tournament): void {
  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.squads.length === 0) throw badRequest('No squads registered yet');
  if (t.squads.length % 2 !== 0) {
    throw forbidden('An odd number of squads cannot be paired; wait for another squad to register', 'odd_squad_count');
  }
  const emptySquad = t.squads.find((s) => !t.teams.some((tm) => tm.squadId === s.id));
  if (emptySquad) {
    throw forbidden(`Squad "${emptySquad.name}" has no members yet`, 'empty_squad');
  }
}

/** Member order used to match coaches inside a squad confrontation: random in round 1, individual rank after. */
function teamMemberOrder(t: Tournament, roundNumber: number): string[] {
  if (roundNumber === 1) return shuffle(t.teams.map((tm) => tm.id));
  return computeStandings(t.teams, t.challenges, t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, t.customStatCategories ?? []).map(
    (s) => s.teamId
  );
}

/**
 * Coach-level matches for the given squad confrontations: the admin's forced coach pairs first,
 * then the remaining members of each side matched by position in `teamMemberOrder` (1st vs 1st,
 * ...); extra members of the bigger squad get a bye.
 */
function buildSquadPairMatches(t: Tournament, squadPairs: Pair[], coachLocks: Pair[], roundNumber: number, now: string): Challenge[] {
  const squadOf = teamSquadLookup(t);
  const memberOrder = teamMemberOrder(t, roundNumber);
  const matches: Challenge[] = [];
  for (const [squadA, squadB] of squadPairs) {
    const locks = coachLocks.filter(([x, y]) => isPair([squadOf(x) ?? '', squadOf(y) ?? ''], squadA, squadB));
    const lockedIds = new Set(locks.flat());
    for (const [x, y] of locks) matches.push(newMatch(x, y, roundNumber, now));
    const membersA = memberOrder.filter((id) => squadOf(id) === squadA && !lockedIds.has(id));
    const membersB = memberOrder.filter((id) => squadOf(id) === squadB && !lockedIds.has(id));
    const pairCount = Math.min(membersA.length, membersB.length);
    for (let i = 0; i < pairCount; i++) matches.push(newMatch(membersA[i], membersB[i], roundNumber, now));
  }
  return matches;
}

function getDraftRound(t: Tournament, roundNumber: number): RoundInfo {
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (!round) throw notFound('Round not found');
  if (round.status !== 'draft') throw forbidden('Only a draft round can be edited', 'round_not_draft');
  return round;
}

/** Remembers a forced pairing, replacing any earlier one involving either side (it can't hold anymore). */
function withLock(locks: Pair[] | undefined, a: string, b: string): Pair[] {
  return [...(locks ?? []).filter(([x, y]) => x !== a && x !== b && y !== a && y !== b), [a, b]];
}

/**
 * Pits `teamId1` against `teamId2` in a draft round — picking any two coaches, regardless of
 * which match or which side (home/away) they're currently on, not just the "away" slot of two
 * whole matches. Their former opponents are freed up by the same move and end up paired with each
 * other, so exactly two matches change and no team is left without an opponent. In team format the
 * two coaches' squads must already face each other this round (see pairRoundSquads), so the swap
 * stays inside that confrontation; a coach on a bye (uneven squads) can be pulled in too, their
 * chosen opponent's former opponent taking the bye instead. The pairing is remembered as forced
 * (picking two coaches who already face each other just locks their match).
 */
export function swapRoundMatches(t: Tournament, roundNumber: number, teamId1: string, teamId2: string): void {
  const round = getDraftRound(t, roundNumber);
  if (teamId1 === teamId2) throw badRequest('Cannot pair a coach against themselves');
  if (!t.teams.some((tm) => tm.id === teamId1) || !t.teams.some((tm) => tm.id === teamId2)) {
    throw notFound('Coach not found in this round');
  }

  const roundMatches = t.challenges.filter((c) => c.round === roundNumber);
  const findMatch = (teamId: string) => roundMatches.find((c) => c.team1Id === teamId || c.team2Id === teamId);
  let match1 = findMatch(teamId1);
  let match2 = findMatch(teamId2);
  const isTeamFormat = t.format === 'team';
  const squadOf = teamSquadLookup(t);
  const rememberLock = () => {
    round.lockedPairs = withLock(round.lockedPairs, teamId1, teamId2);
    if (isTeamFormat) round.lockedSquadPairs = withLock(round.lockedSquadPairs, squadOf(teamId1)!, squadOf(teamId2)!);
  };
  // Already paired (e.g. by the draw): nothing to move, just remember the admin wants it kept.
  if (match1 && match1 === match2) {
    rememberLock();
    return;
  }

  if (isTeamFormat) {
    const squad1 = squadOf(teamId1);
    const squad2 = squadOf(teamId2);
    if (squad1 === squad2) {
      throw forbidden(
        'In team format, this swap would pit two players from the same squad against each other',
        'swap_creates_same_squad_match'
      );
    }
    const squadsFaceEachOther = roundMatches.some((c) => isPair([squadOf(c.team1Id) ?? '', squadOf(c.team2Id) ?? ''], squad1 ?? '', squad2 ?? ''));
    if (!squadsFaceEachOther) {
      throw forbidden(
        "Ces deux coachs ne sont pas dans des équipes qui s'affrontent : faites d'abord s'affronter leurs équipes",
        'squads_not_paired'
      );
    }
  } else if (!match1 || !match2) {
    throw notFound('Coach not found in this round');
  }

  const now = new Date().toISOString();
  const opponentOf = (match: Challenge, teamId: string) => (match.team1Id === teamId ? match.team2Id : match.team1Id);
  const replaceOpponent = (match: Challenge, oldOpponentId: string, newOpponentId: string) => {
    if (match.team1Id === oldOpponentId) match.team1Id = newOpponentId;
    else match.team2Id = newOpponentId;
    match.updatedAt = now;
  };

  // Team format only (individual format checked both matches exist above): normalise so that if
  // exactly one of the two coaches is on a bye, it's teamId2.
  let [a, b] = [teamId1, teamId2];
  if (!match1 && match2) {
    [a, b] = [b, a];
    [match1, match2] = [match2, match1];
  }

  if (match1 && match2) {
    const opp1 = opponentOf(match1, a); // freed up by `a` leaving to face `b`
    const opp2 = opponentOf(match2, b); // freed up by `b` leaving to face `a`, ends up facing opp1
    if (isTeamFormat && squadOf(opp1) === squadOf(opp2)) {
      throw forbidden(
        'In team format, this swap would pit two players from the same squad against each other',
        'swap_creates_same_squad_match'
      );
    }
    replaceOpponent(match1, opp1, b);
    replaceOpponent(match2, b, opp1);
  } else if (match1) {
    replaceOpponent(match1, opponentOf(match1, a), b); // `a`'s former opponent now takes `b`'s bye
  } else {
    t.challenges.push(newMatch(a, b, roundNumber, now));
  }

  rememberLock();
}

/**
 * Team format: pits `squadId1` against `squadId2` in a draft round. Their former opponents (freed
 * up by the move) face each other in turn, and every coach of the affected confrontations is
 * re-matched — at random in round 1, by individual rank afterwards — except for forced coach
 * pairings that still hold. The squad pairing is remembered as forced.
 */
export function pairRoundSquads(t: Tournament, roundNumber: number, squadId1: string, squadId2: string): void {
  if (t.format !== 'team') throw badRequest('Only team format tournaments have squads');
  const round = getDraftRound(t, roundNumber);
  if (squadId1 === squadId2) throw badRequest('Cannot pair a squad against itself');
  if (!t.squads.some((s) => s.id === squadId1) || !t.squads.some((s) => s.id === squadId2)) {
    throw notFound('Squad not found');
  }

  const squadOf = teamSquadLookup(t);
  const roundMatches = t.challenges.filter((c) => c.round === roundNumber);
  if (roundMatches.some((c) => c.result !== null)) {
    throw forbidden('Cannot re-pair a round once a match has been played', 'round_already_played');
  }
  const opponentsOf = (squadId: string) => {
    const opponents = new Set<string>();
    for (const c of roundMatches) {
      const [x, y] = [squadOf(c.team1Id), squadOf(c.team2Id)];
      if (x === squadId && y) opponents.add(y);
      if (y === squadId && x) opponents.add(x);
    }
    return opponents;
  };
  const opponents1 = opponentsOf(squadId1);
  if (opponents1.size === 1 && opponents1.has(squadId2)) throw badRequest("Ces deux équipes s'affrontent déjà");

  const affected = new Set([squadId1, squadId2, ...opponents1, ...opponentsOf(squadId2)]);
  const freedUp = [...affected].filter((id) => id !== squadId1 && id !== squadId2);
  if (freedUp.length % 2 !== 0) throw forbidden('An odd number of squads cannot be paired', 'odd_squad_count');
  const newPairs: Pair[] = [[squadId1, squadId2], ...pairInOrder(freedUp, new Map())];

  round.lockedSquadPairs = [...(round.lockedSquadPairs ?? []).filter(([x, y]) => !affected.has(x) && !affected.has(y)), [squadId1, squadId2]];
  round.lockedPairs = (round.lockedPairs ?? []).filter(([x, y]) => {
    const [sx, sy] = [squadOf(x) ?? '', squadOf(y) ?? ''];
    return (!affected.has(sx) && !affected.has(sy)) || newPairs.some((p) => isPair(p, sx, sy));
  });

  const now = new Date().toISOString();
  t.challenges = t.challenges.filter(
    (c) => c.round !== roundNumber || (!affected.has(squadOf(c.team1Id) ?? '') && !affected.has(squadOf(c.team2Id) ?? ''))
  );
  t.challenges.push(...buildSquadPairMatches(t, newPairs, round.lockedPairs, roundNumber, now));
}

/**
 * Redraws round 1 (still in draft) at random — e.g. after late registrations, or simply for a new
 * draw. With `keepLocks`, every pairing the admin forced is kept (squad and coach level); without,
 * those are forgotten too. swiss_with_challenge's pre-round challenges always stay. Only round 1:
 * later rounds are paired from standings, not drawn.
 */
export function rerandomizeRound(t: Tournament, roundNumber: number, keepLocks: boolean): void {
  const round = getDraftRound(t, roundNumber);
  if ((t.mode !== 'swiss' && t.mode !== 'swiss_with_challenge') || roundNumber !== 1 || t.rounds.length !== 1) {
    throw forbidden('Only round 1 of a swiss tournament can be redrawn', 'round_not_redrawable');
  }
  const fixedIds = new Set(round.fixedChallengeIds ?? []);
  const roundMatches = t.challenges.filter((c) => c.round === roundNumber);
  if (roundMatches.some((c) => !fixedIds.has(c.id) && c.result !== null)) {
    throw forbidden('Cannot redraw a round once a match has been played', 'round_already_played');
  }
  if (!keepLocks) {
    round.lockedPairs = [];
    round.lockedSquadPairs = [];
  }

  const now = new Date().toISOString();
  if (t.format === 'team') {
    assertSquadsPairable(t);
    const squadIds = new Set(t.squads.map((s) => s.id));
    const usedSquads = new Set<string>();
    const squadPairs: Pair[] = [];
    for (const [x, y] of round.lockedSquadPairs ?? []) {
      if (!squadIds.has(x) || !squadIds.has(y) || usedSquads.has(x) || usedSquads.has(y)) continue;
      squadPairs.push([x, y]);
      usedSquads.add(x);
      usedSquads.add(y);
    }
    round.lockedSquadPairs = squadPairs.slice();
    squadPairs.push(...pairInOrder(shuffle(t.squads.map((s) => s.id).filter((id) => !usedSquads.has(id))), new Map()));

    t.challenges = t.challenges.filter((c) => c.round !== roundNumber);
    t.challenges.push(...buildSquadPairMatches(t, squadPairs, round.lockedPairs ?? [], roundNumber, now));
    return;
  }

  assertTeamsPairable(t);
  const kept = roundMatches.filter((c) => fixedIds.has(c.id));
  const used = new Set(kept.flatMap((c) => [c.team1Id, c.team2Id]));
  const teamIds = new Set(t.teams.map((tm) => tm.id));
  const validLocks: Pair[] = [];
  for (const [x, y] of round.lockedPairs ?? []) {
    if (!teamIds.has(x) || !teamIds.has(y) || used.has(x) || used.has(y)) continue;
    validLocks.push([x, y]);
    used.add(x);
    used.add(y);
    kept.push(roundMatches.find((c) => isPair([c.team1Id, c.team2Id], x, y)) ?? newMatch(x, y, roundNumber, now));
  }
  round.lockedPairs = validLocks;
  const pairs = pairInOrder(shuffle(t.teams.map((tm) => tm.id).filter((id) => !used.has(id))), new Map());

  t.challenges = t.challenges.filter((c) => c.round !== roundNumber);
  t.challenges.push(...kept, ...pairs.map(([team1Id, team2Id]) => newMatch(team1Id, team2Id, roundNumber, now)));
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
