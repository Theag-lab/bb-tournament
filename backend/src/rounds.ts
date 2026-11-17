import { v4 as uuidv4 } from 'uuid';
import {
  Challenge,
  RoundInfo,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_SQUAD_SCORING,
  Tournament,
  activeCoaches,
  activeSquadMembers,
  computeSquadStandings,
  computeStandings,
} from '@bb-tournament/shared';
import { badRequest, forbidden, notFound } from './errors';
import { assertPreviousRoundComplete, buildPriorOpponents, pairInOrder, shuffle } from './pairing';
import { generateNextPoolsKnockoutRound } from './bracket';

type Pair = [string, string];
type Triangle = [string, string, string];
/** One round confrontation: two squads, or three playing a triangle (odd number of squads). */
type SquadGroup = Pair | Triangle;

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
 * Round 1 pairs are random; rounds 2+ pair teams adjacent in the current standings, avoiding rematches where possible.
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

  const roundNumber = t.rounds.length + 1;
  assertTeamsPairable(t, roundNumber);
  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  // A substitute takes the replaced coach's seat: combined results, and their opponents to avoid.
  const priorOpponents = buildPriorOpponents(seatChallenges(t, roundNumber));
  const candidateIds =
    roundNumber > 1 ? pairingStandings(t, roundNumber) : shuffle([...activeCoaches(t.teams, t.replacements, roundNumber)]);

  const pairs = pairInOrder(candidateIds, priorOpponents);

  t.challenges.push(...pairs.map(([team1Id, team2Id]) => newMatch(team1Id, team2Id, roundNumber, now)));
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

/**
 * Each coach's seat holder for round `roundNumber`: a replaced coach and everyone who replaced them
 * share one seat, held by whichever of them plays that round; other coaches hold their own seat.
 */
export function seatHolders(t: Tournament, roundNumber: number): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const r of t.replacements ?? []) parent.set(find(r.inTeamId), find(r.outTeamId));
  const playing = activeCoaches(t.teams, t.replacements, roundNumber);
  const holderOfRoot = new Map<string, string>();
  for (const id of playing) holderOfRoot.set(find(id), id);
  return new Map(t.teams.map((tm) => [tm.id, holderOfRoot.get(find(tm.id)) ?? tm.id]));
}

/** The tournament's matches with every coach replaced by its seat holder for round `roundNumber`. */
function seatChallenges(t: Tournament, roundNumber: number): Challenge[] {
  const holders = seatHolders(t, roundNumber);
  return t.challenges.map((c) => ({ ...c, team1Id: holders.get(c.team1Id) ?? c.team1Id, team2Id: holders.get(c.team2Id) ?? c.team2Id }));
}

/**
 * Coaches playing round `roundNumber`, ranked for pairing: each one with the combined results of
 * its seat (a substitute ranks with the replaced coach's results plus its own).
 */
export function pairingStandings(t: Tournament, roundNumber: number): string[] {
  const playing = activeCoaches(t.teams, t.replacements, roundNumber);
  return computeStandings(
    t.teams.filter((tm) => playing.has(tm.id)),
    seatChallenges(t, roundNumber),
    t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
    t.customStatCategories ?? [],
    t.rosterTiers
  ).map((s) => s.teamId);
}

function assertTeamsPairable(t: Tournament, roundNumber: number): void {
  const playing = activeCoaches(t.teams, t.replacements, roundNumber).size;
  if (playing === 0) throw badRequest('No teams registered yet');
  if (playing % 2 !== 0) {
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
 * Picks the three squads of the triangle from the bottom of `orderedIds` (squad standings), so the
 * triangle stays at the bottom of the table — a squad may play several triangles. What matters is
 * that no two coaches meet twice: trios are tried bottom-up (the lowest-ranked squad with the next
 * lowest ones first) and the first one whose coaches can all face new opponents
 * (`coachRematches` = 0) is taken; otherwise the one with the fewest coach rematches.
 */
export function pickTriangle(orderedIds: string[], coachRematches: (group: SquadGroup) => number = () => 0): Triangle {
  const bottomUp = orderedIds.slice().reverse();
  let best: Triangle = [bottomUp[0], bottomUp[1], bottomUp[2]];
  let bestCost = Infinity;
  for (let i = 0; i < bottomUp.length; i++) {
    for (let j = i + 1; j < bottomUp.length; j++) {
      for (let k = j + 1; k < bottomUp.length; k++) {
        const triangle: Triangle = [bottomUp[i], bottomUp[j], bottomUp[k]];
        const cost = coachRematches(triangle);
        if (cost === 0) return triangle;
        if (cost < bestCost) [best, bestCost] = [triangle, cost];
      }
    }
  }
  return best;
}

/**
 * Pairs squads walking down `orderedIds` (squad standings), each one with the nearest squad below
 * it, preferring in this order: a squad it never met; one it met but whose coaches can all face
 * new opponents (`coachRematches` = 0); then the fewest coach rematches. Without `coachRematches`
 * this is plain `pairInOrder`.
 */
export function pairSquadsInOrder(
  orderedIds: string[],
  priorOpponents: Map<string, Set<string>>,
  coachRematches: (pair: Pair) => number = () => 0
): Pair[] {
  const pairs: Pair[] = [];
  const used = new Set<string>();
  for (const a of orderedIds) {
    if (used.has(a)) continue;
    used.add(a);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const b of orderedIds) {
      if (used.has(b)) continue;
      const score = coachRematches([a, b]) * 2 + (priorOpponents.get(a)?.has(b) ? 1 : 0);
      if (score < bestScore) [best, bestScore] = [b, score];
      if (score === 0) break;
    }
    if (best) {
      used.add(best);
      pairs.push([a, best]);
    }
  }
  return pairs;
}

/** Pairs squads (see pairSquadsInOrder); an odd count puts three of them in a triangle (listed last, see pickTriangle). */
export function groupSquadsInOrder(
  orderedIds: string[],
  priorOpponents: Map<string, Set<string>>,
  coachRematches?: (group: SquadGroup) => number
): SquadGroup[] {
  if (orderedIds.length % 2 === 0) return pairSquadsInOrder(orderedIds, priorOpponents, coachRematches);
  if (orderedIds.length < 3) {
    throw forbidden('An odd number of squads needs at least three squads to form a triangle', 'odd_squad_count');
  }
  const triangle = pickTriangle(orderedIds, coachRematches);
  return [...pairSquadsInOrder(orderedIds.filter((id) => !triangle.includes(id)), priorOpponents, coachRematches), triangle];
}

/**
 * Double-swiss pairing for 'team' format tournaments: squads are paired adjacent in squad
 * standings (see pairSquadsInOrder; an odd count adds a triangle, see pickTriangle), then within
 * each confrontation members are matched by their individual rank inside their own squad (1st vs
 * 1st, 2nd vs 2nd, ...). The rule above all: two coaches never meet twice where it can be avoided
 * — it steers both which squads face each other and which coaches. Uneven squad sizes leave the extra lower-ranked members without a match that round
 * (implicit bye, no challenge created for them). Round 1 has no standings yet, so both squads and
 * members are drawn at random instead.
 */
function generateNextTeamRound(t: Tournament): void {
  assertSquadsPairable(t);

  const roundNumber = t.rounds.length + 1;
  assertPreviousRoundComplete(t, roundNumber);

  const now = new Date().toISOString();
  const squadOf = teamSquadLookup(t);
  const memberOrder = teamMemberOrder(t, roundNumber);
  const priorCoaches = priorCoachOpponents(t, roundNumber);
  const membersOf = (squadId: string) => memberOrder.filter((id) => squadOf(id) === squadId);
  const coachRematches = (group: SquadGroup) => planGroup(group, membersOf, squadOf, priorCoaches).rematches;
  const squadGroups =
    roundNumber === 1
      ? groupSquadsInOrder(shuffle(t.squads.map((s) => s.id)), new Map())
      : groupSquadsInOrder(
          computeSquadStandings(
            t.squads,
            t.teams,
            t.challenges,
            t.squadScoring ?? DEFAULT_SQUAD_SCORING,
            t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
            t.customStatCategories ?? [],
            t.rosterTiers
          ).map((s) => s.squadId),
          buildPriorSquadOpponents(t.challenges, new Map(t.teams.map((tm) => [tm.id, tm.squadId]))),
          coachRematches
        );

  t.challenges.push(...buildSquadPairMatches(t, squadGroups, [], roundNumber, now, memberOrder));
  t.rounds.push({ number: roundNumber, status: 'draft' });
}

function assertSquadsPairable(t: Tournament): void {
  if (t.teams.length === 0) throw badRequest('No teams registered yet');
  if (t.squads.length === 0) throw badRequest('No squads registered yet');
  if (t.squads.length < 2) throw forbidden('At least two squads are needed', 'odd_squad_count');
  const emptySquad = t.squads.find((s) => !t.teams.some((tm) => tm.squadId === s.id));
  if (emptySquad) {
    throw forbidden(`Squad "${emptySquad.name}" has no members yet`, 'empty_squad');
  }
}

/** Coaches playing round `roundNumber` for their squad, replacements applied (see activeSquadMembers). */
export function playingCoaches(t: Tournament, roundNumber: number): Set<string> {
  return new Set(t.squads.flatMap((sq) => [...activeSquadMembers(t.teams, t.replacements, sq.id, roundNumber)]));
}

/**
 * Member order used to match coaches inside a squad confrontation: random in round 1, individual
 * rank after (a substitute with its seat's combined results, see pairingStandings) — only the
 * coaches playing that round.
 */
function teamMemberOrder(t: Tournament, roundNumber: number): string[] {
  const playing = playingCoaches(t, roundNumber);
  const order = roundNumber === 1 ? shuffle(t.teams.map((tm) => tm.id)) : pairingStandings(t, roundNumber);
  return order.filter((id) => playing.has(id));
}

/**
 * Coach-level matches for the given squad confrontations: the admin's forced coach pairs first,
 * then the remaining members of each side matched so that no two coaches meet again where
 * possible, by position in `teamMemberOrder` otherwise (1st vs 1st, ...); extra members of the
 * bigger squad get a bye.
 *
 * A triangle [A, B, C] splits each squad's remaining members in two halves, one per opposing squad
 * (with squads of 4, 2 boards against each of the two others) — see planTriangle for how coaches
 * who already met are kept apart.
 */
function buildSquadPairMatches(
  t: Tournament,
  squadGroups: SquadGroup[],
  coachLocks: Pair[],
  roundNumber: number,
  now: string,
  memberOrder: string[] = teamMemberOrder(t, roundNumber)
): Challenge[] {
  const squadOf = teamSquadLookup(t);
  const matches: Challenge[] = [];
  let priorOpponents: Map<string, Set<string>> | null = null; // only computed when there's a triangle
  for (const group of squadGroups) {
    const locks = coachLocks.filter(([x, y]) => {
      const [sx, sy] = [squadOf(x) ?? '', squadOf(y) ?? ''];
      return sx !== sy && group.includes(sx) && group.includes(sy);
    });
    const lockedIds = new Set(locks.flat());
    // The group's first squad always on the team1 side, so the confrontation renders the same way round the scoreboard.
    for (const [x, y] of locks) {
      matches.push(group.indexOf(squadOf(x)!) < group.indexOf(squadOf(y)!) ? newMatch(x, y, roundNumber, now) : newMatch(y, x, roundNumber, now));
    }
    const membersOf = (squadId: string) => memberOrder.filter((id) => squadOf(id) === squadId && !lockedIds.has(id));
    priorOpponents ??= priorCoachOpponents(t, roundNumber);
    for (const [x, y] of planGroup(group, membersOf, squadOf, priorOpponents).pairs) matches.push(newMatch(x, y, roundNumber, now));
  }
  return matches;
}

/** Every coach's opponents in earlier rounds (and free challenges), to keep triangle coaches from meeting again. */
function priorCoachOpponents(t: Tournament, roundNumber: number): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const c of t.challenges) {
    if (c.round !== null && c.round >= roundNumber) continue;
    for (const [x, y] of [[c.team1Id, c.team2Id], [c.team2Id, c.team1Id]]) {
      if (!map.has(x)) map.set(x, new Set());
      map.get(x)!.add(y);
    }
  }
  return map;
}

/** Every way to pick `k` of the indices 0..n-1, in lexicographic order. */
function combinations(n: number, k: number): number[][] {
  if (k === 0) return [[]];
  const result: number[][] = [];
  for (let first = 0; first <= n - k; first++) {
    for (const rest of combinations(n - first - 1, k - 1)) result.push([first, ...rest.map((i) => i + first + 1)]);
  }
  return result;
}

/**
 * The ways to split `members` (rank order) into the ones facing the squad's first opponent (the
 * bigger half when odd) and the ones facing its second: the plain alternating split by rank
 * (1st, 3rd, ... / 2nd, 4th, ...) first, then every other split.
 */
function triangleSplits(members: string[]): [string[], string[]][] {
  const firstSize = Math.ceil(members.length / 2);
  const alternating = members.map((_, i) => i).filter((i) => i % 2 === 0);
  const others = combinations(members.length, firstSize).filter((c) => c.join() !== alternating.join());
  return [alternating, ...others].map((first) => [members.filter((_, i) => first.includes(i)), members.filter((_, i) => !first.includes(i))]);
}

/** Coach matches of one confrontation (pair or triangle) and how many of them are coach rematches. */
export function planGroup(
  group: SquadGroup,
  membersOf: (squadId: string) => string[],
  squadOf: (teamId: string) => string | null,
  priorOpponents: Map<string, Set<string>>
): { pairs: [string, string][]; rematches: number } {
  if (group.length === 3) return planTriangle(group, membersOf, squadOf, priorOpponents);
  const faced = (x: string, y: string) => priorOpponents.get(x)?.has(y) ?? false;
  const pairs = pairAvoidingRematches(membersOf(group[0]), membersOf(group[1]), faced);
  return { pairs, rematches: pairs.filter(([x, y]) => faced(x, y)).length };
}

/**
 * Coach matches of the triangle [A, B, C] (A vs B, B vs C, C vs A boards), choosing which coaches
 * of each squad face which opposing squad, and who faces whom, so that:
 *  1. as few coaches as possible meet an opponent they already played (`rematches`, the number of
 *     such matches — what pickTriangle minimises),
 *  2. then as few as possible face a squad they already played (e.g. A1 and A2 already faced B:
 *     this time they face C),
 *  3. then the plain order by rank (alternating halves, 1st vs 1st).
 */
export function planTriangle(
  [a, b, c]: Triangle,
  membersOf: (squadId: string) => string[],
  squadOf: (teamId: string) => string | null,
  priorOpponents: Map<string, Set<string>>
): { pairs: [string, string][]; rematches: number } {
  const facedCoach = (x: string, y: string) => priorOpponents.get(x)?.has(y) ?? false;
  const facedSquad = (coach: string, squadId: string) => [...(priorOpponents.get(coach) ?? [])].some((id) => squadOf(id) === squadId);
  const splitsA = triangleSplits(membersOf(a)); // [facing B, facing C]
  const splitsB = triangleSplits(membersOf(b)); // [facing A, facing C]
  const splitsC = triangleSplits(membersOf(c)); // [facing B, facing A]
  let best: { pairs: [string, string][]; rematches: number } = { pairs: [], rematches: Infinity };
  let bestScore = Infinity;
  for (const [aToB, aToC] of splitsA) {
    for (const [bToA, bToC] of splitsB) {
      for (const [cToB, cToA] of splitsC) {
        const pairs = [
          ...pairAvoidingRematches(aToB, bToA, facedCoach),
          ...pairAvoidingRematches(bToC, cToB, facedCoach),
          ...pairAvoidingRematches(cToA, aToC, facedCoach),
        ];
        const rematches = pairs.filter(([x, y]) => facedCoach(x, y)).length;
        const squadRepeats = pairs.filter(([x, y]) => facedSquad(x, squadOf(y)!) || facedSquad(y, squadOf(x)!)).length;
        const score = rematches * 1000 + squadRepeats;
        if (score < bestScore) [best, bestScore] = [{ pairs, rematches }, score];
        if (bestScore === 0) return best;
      }
    }
  }
  return best;
}

/**
 * Pairs `xs` with `ys` (both in rank order) with as few rematches between two coaches as possible;
 * ties keep the rank order (1st vs 1st, ...). Extra coaches on the longer side get a bye.
 */
export function pairAvoidingRematches(xs: string[], ys: string[], faced: (x: string, y: string) => boolean): [string, string][] {
  const count = Math.min(xs.length, ys.length);
  let best: string[] = ys.slice(0, count);
  let bestCost = Infinity;
  const used = new Set<number>();
  const chosen: string[] = [];
  const search = (i: number, costSoFar: number) => {
    if (costSoFar >= bestCost) return;
    if (i === count) {
      [best, bestCost] = [chosen.slice(), costSoFar];
      return;
    }
    for (let j = 0; j < ys.length && bestCost > 0; j++) {
      if (used.has(j)) continue;
      used.add(j);
      chosen.push(ys[j]);
      search(i + 1, costSoFar + (faced(xs[i], ys[j]) ? 1 : 0));
      chosen.pop();
      used.delete(j);
    }
  };
  search(0, 0);
  return best.map((y, i) => [xs[i], y]);
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
    const playing = playingCoaches(t, roundNumber);
    if (!playing.has(teamId1) || !playing.has(teamId2)) {
      throw forbidden("Ce coach ne joue pas cette ronde (remplacé, ou remplaçant pas encore entré)", 'coach_not_playing');
    }
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
  if (freedUp.length % 2 !== 0 && freedUp.length < 3) {
    throw forbidden(
      "Impossible : avec un nombre impair d'équipes, trois équipes doivent jouer en triangle. Faites plutôt affronter une équipe du triangle à une équipe d'une autre rencontre.",
      'odd_squad_count'
    );
  }
  // An odd number of freed-up squads (a triangle was broken up) forms a new triangle.
  const newPairs: SquadGroup[] = [[squadId1, squadId2], ...groupSquadsInOrder(freedUp, new Map())];

  round.lockedSquadPairs = [...(round.lockedSquadPairs ?? []).filter(([x, y]) => !affected.has(x) && !affected.has(y)), [squadId1, squadId2]];
  round.lockedPairs = (round.lockedPairs ?? []).filter(([x, y]) => {
    const [sx, sy] = [squadOf(x) ?? '', squadOf(y) ?? ''];
    return (!affected.has(sx) && !affected.has(sy)) || newPairs.some((p) => sx !== sy && p.includes(sx) && p.includes(sy));
  });

  const now = new Date().toISOString();
  const isAffected = (c: Challenge) =>
    c.round === roundNumber && (affected.has(squadOf(c.team1Id) ?? '') || affected.has(squadOf(c.team2Id) ?? ''));
  // The new matches take the place of the ones they replace, so the other confrontations keep
  // their table numbers (tables follow the round's match order).
  const insertAt = t.challenges.findIndex(isAffected);
  const kept = t.challenges.filter((c) => !isAffected(c));
  const keptBefore = insertAt === -1 ? kept.length : t.challenges.slice(0, insertAt).filter((c) => !isAffected(c)).length;
  kept.splice(keptBefore, 0, ...buildSquadPairMatches(t, newPairs, round.lockedPairs, roundNumber, now));
  t.challenges = kept;
}

/**
 * Redraws round 1 (still in draft) at random — e.g. after late registrations, or simply for a new
 * draw. With `keepLocks`, every pairing the admin forced is kept (squad and coach level); without,
 * those are forgotten too. Only round 1: later rounds are paired from standings, not drawn.
 */
export function rerandomizeRound(t: Tournament, roundNumber: number, keepLocks: boolean): void {
  const round = getDraftRound(t, roundNumber);
  if (t.mode !== 'swiss' || roundNumber !== 1 || t.rounds.length !== 1) {
    throw forbidden('Only round 1 of a swiss tournament can be redrawn', 'round_not_redrawable');
  }
  const roundMatches = t.challenges.filter((c) => c.round === roundNumber);
  if (roundMatches.some((c) => c.result !== null)) {
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
    // An odd count needs three free squads for the triangle: drop the last forced pairing if only one is left.
    if (t.squads.length % 2 === 1 && t.squads.length - usedSquads.size < 3) {
      const [x, y] = squadPairs.pop()!;
      usedSquads.delete(x);
      usedSquads.delete(y);
    }
    round.lockedSquadPairs = squadPairs.slice();
    const squadGroups: SquadGroup[] = [
      ...squadPairs,
      ...groupSquadsInOrder(shuffle(t.squads.map((s) => s.id).filter((id) => !usedSquads.has(id))), new Map()),
    ];

    t.challenges = t.challenges.filter((c) => c.round !== roundNumber);
    t.challenges.push(...buildSquadPairMatches(t, squadGroups, round.lockedPairs ?? [], roundNumber, now));
    return;
  }

  assertTeamsPairable(t, roundNumber);
  const kept: Challenge[] = [];
  const used = new Set<string>();
  const teamIds = activeCoaches(t.teams, t.replacements, roundNumber);
  const validLocks: Pair[] = [];
  for (const [x, y] of round.lockedPairs ?? []) {
    if (!teamIds.has(x) || !teamIds.has(y) || used.has(x) || used.has(y)) continue;
    validLocks.push([x, y]);
    used.add(x);
    used.add(y);
    kept.push(roundMatches.find((c) => isPair([c.team1Id, c.team2Id], x, y)) ?? newMatch(x, y, roundNumber, now));
  }
  round.lockedPairs = validLocks;
  const pairs = pairInOrder(shuffle([...teamIds].filter((id) => !used.has(id))), new Map());

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
 * Deletes the tournament's LAST round (draft or launched) and its matches, so it can be generated
 * again from scratch. Only ever the last round: an earlier round has later rounds generated from
 * its outcome. Refuses once any of its matches has a result — this undoes a pairing, never a
 * played match. Cancelling the first knockout round also un-launches the knockout phase (its seeds are recomputed when it's launched again).
 */
export function cancelRound(t: Tournament, roundNumber: number): void {
  const lastRound = t.rounds[t.rounds.length - 1];
  if (!lastRound || lastRound.number !== roundNumber) {
    throw forbidden('Only the last round can be cancelled', 'not_last_round');
  }
  const anyPlayed = t.challenges.some((c) => c.round === roundNumber && c.result !== null);
  if (anyPlayed) {
    throw forbidden('Cannot cancel a round once a match has been played', 'round_already_played');
  }

  t.challenges = t.challenges.filter((c) => c.round !== roundNumber);
  t.rounds.pop();
  if (t.mode === 'pools_knockout' && t.poolRoundCount !== null && roundNumber === t.poolRoundCount + 1) {
    t.knockoutSeeds = null;
  }
}
