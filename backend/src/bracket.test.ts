import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_ROUND_TIMER,
  type Challenge,
  type MatchResult,
  type Pool,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';
import { buildBracketView, generateNextPoolsKnockoutRound, getKnockoutChampion, launchKnockoutPhase } from './bracket';

function team(id: string, poolId: string | null): Team {
  return {
    id,
    password: 'password123',
    name: id,
    coachName: id,
    race: 'Human',
    nafNumber: null,
    squadId: null,
    poolId,
    createdAt: '2026-01-01T00:00:00.000Z',
    rosterImage: null,
    rosterStatus: 'created',
  };
}

function pool(id: string, name: string): Pool {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z' };
}

function baseTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't1',
    name: 'Coupe de Test',
    description: '',
    organizerCoachName: 'Jean Organisateur',
    requireRosterValidation: false,
    requireResultConfirmation: true,
    showTeamNames: true,
    mode: 'pools_knockout',
    roundCount: null,
    rounds: [],
    format: 'individual',
    squadSize: null,
    squadScoring: null,
    squads: [],
    poolSize: 2,
    poolRoundCount: 1,
    qualifiersPerPool: 1,
    pools: [pool('pA', 'Poule A'), pool('pB', 'Poule B')],
    knockoutSeeds: null,
    individualScoring: DEFAULT_INDIVIDUAL_SCORING,
    roundTimer: DEFAULT_ROUND_TIMER,
    adminToken: 'admin-token',
    createdAt: '2026-01-01T00:00:00.000Z',
    teams: [team('a1', 'pA'), team('a2', 'pA'), team('b1', 'pB'), team('b2', 'pB')],
    challenges: [],
    ...overrides,
  };
}

function completeResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    playedAt: '2026-01-01',
    team1Td: 2,
    team2Td: 0,
    team1Cas: 0,
    team2Cas: 0,
    team1Agg: 0,
    team2Agg: 0,
    concededByTeamId: null,
    team1Points: 5,
    team2Points: 0,
    submittedByTeamId: 'a1',
    submittedAt: '2026-01-01T00:00:00.000Z',
    confirmedByTeamId: 'a2',
    completedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Completes every challenge of the given round with a plain team1-wins-2-0 result. */
function completeRound(t: Tournament, roundNumber: number): void {
  for (const c of t.challenges) {
    if (c.round === roundNumber) {
      c.status = 'completed';
      c.result = completeResult({ submittedByTeamId: c.team1Id, confirmedByTeamId: c.team2Id });
    }
  }
}

/**
 * Completes every challenge of the given round, making `winnerOf(challenge)` win 2-0 regardless
 * of which side it landed on — needed for the pool phase, whose round-1 pairing order is shuffled
 * (unlike knockout pairing, which is deterministic), so "team1 always wins" can't guarantee a
 * specific team advances.
 */
function completeRoundWithWinner(t: Tournament, roundNumber: number, winnerOf: (c: Challenge) => string): void {
  for (const c of t.challenges) {
    if (c.round !== roundNumber) continue;
    const winner = winnerOf(c);
    const winnerIsTeam1 = c.team1Id === winner;
    c.status = 'completed';
    c.result = completeResult({
      team1Td: winnerIsTeam1 ? 2 : 0,
      team2Td: winnerIsTeam1 ? 0 : 2,
      team1Points: winnerIsTeam1 ? 5 : 0,
      team2Points: winnerIsTeam1 ? 0 : 5,
      submittedByTeamId: c.team1Id,
      confirmedByTeamId: c.team2Id,
    });
  }
}

describe('pools_knockout round generation lifecycle', () => {
  test('generates a pool-phase round pairing only within each pool', () => {
    const t = baseTournament();
    generateNextPoolsKnockoutRound(t);
    assert.equal(t.rounds.length, 1);
    assert.equal(t.rounds[0].number, 1);
    const pairs = t.challenges.filter((c) => c.round === 1);
    assert.equal(pairs.length, 2);
    for (const c of pairs) {
      const poolOfTeam = (id: string) => t.teams.find((tm) => tm.id === id)!.poolId;
      assert.equal(poolOfTeam(c.team1Id), poolOfTeam(c.team2Id));
    }
  });

  test('refuses to generate a pool round when a team has no pool assigned', () => {
    const t = baseTournament({ teams: [team('a1', 'pA'), team('a2', null), team('b1', 'pB'), team('b2', 'pB')] });
    assert.throws(() => generateNextPoolsKnockoutRound(t));
  });

  test('generates every pool round independently of prior-round completion — fast coaches can get ahead', () => {
    // 4 teams in a single pool: a full round-robin needs exactly 3 rounds, none of which need any
    // result from the others to be computed.
    const t = baseTournament({
      poolRoundCount: 3,
      pools: [pool('pA', 'Poule A')],
      teams: [team('a1', 'pA'), team('a2', 'pA'), team('a3', 'pA'), team('a4', 'pA')],
    });

    generateNextPoolsKnockoutRound(t); // round 1 — nobody has played yet
    assert.equal(t.rounds.length, 1);

    // Round 1 is left entirely unplayed on purpose; generating round 2 must not throw.
    generateNextPoolsKnockoutRound(t); // round 2
    assert.equal(t.rounds.length, 2);

    // Round 2 is also left unplayed; round 3 must still be generatable.
    generateNextPoolsKnockoutRound(t); // round 3
    assert.equal(t.rounds.length, 3);

    const pairKey = (c: Challenge) => [c.team1Id, c.team2Id].sort().join('-');
    const allPairs = [1, 2, 3].flatMap((n) => t.challenges.filter((c) => c.round === n).map(pairKey));
    assert.equal(allPairs.length, 6); // C(4,2): every pairing appears exactly once across the 3 rounds
    assert.equal(new Set(allPairs).size, 6, 'no pairing repeats across rounds');
  });

  test('full lifecycle: pool round -> launch knockout -> final -> champion', () => {
    const t = baseTournament();
    generateNextPoolsKnockoutRound(t); // round 1: pool phase
    completeRoundWithWinner(t, 1, (c) => (c.team1Id === 'a1' || c.team2Id === 'a1' ? 'a1' : 'b1'));

    launchKnockoutPhase(t);
    assert.ok(t.knockoutSeeds !== null);
    assert.equal(t.rounds.length, 2);
    assert.equal(t.rounds[1].number, 2);
    const final = t.challenges.filter((c) => c.round === 2);
    assert.equal(final.length, 1, 'two pool winners (1 per pool) means a single final match, no byes');

    let bracket = buildBracketView(t);
    assert.ok(bracket);
    assert.equal(bracket!.length, 1);
    assert.equal(bracket![0].matches[0].winnerTeamId, null);
    assert.equal(getKnockoutChampion(bracket), null);

    completeRound(t, 2);
    bracket = buildBracketView(t);
    assert.equal(bracket![0].matches[0].winnerTeamId, 'a1');
    assert.equal(getKnockoutChampion(bracket), 'a1');

    assert.throws(() => generateNextPoolsKnockoutRound(t), /knockout_complete|already terminé|déjà terminé/i);
  });

  test('refuses to launch the knockout phase before pool rounds are complete', () => {
    const t = baseTournament();
    generateNextPoolsKnockoutRound(t);
    // round 1 left incomplete
    assert.throws(() => launchKnockoutPhase(t));
  });

  test('byes are given to top seeds when the qualifier count is not a power of two', () => {
    const t = baseTournament({
      poolSize: 3,
      qualifiersPerPool: 1,
      pools: [pool('pA', 'Poule A'), pool('pB', 'Poule B'), pool('pC', 'Poule C')],
      teams: [
        team('a1', 'pA'),
        team('a2', 'pA'),
        team('b1', 'pB'),
        team('b2', 'pB'),
        team('c1', 'pC'),
        team('c2', 'pC'),
      ],
    });
    generateNextPoolsKnockoutRound(t);
    completeRound(t, 1); // a1, b1, c1 win their pool (team1 always wins in completeResult)

    launchKnockoutPhase(t);
    const bracket = buildBracketView(t)!;
    assert.equal(bracket[0].byes.length, 1);
    assert.equal(bracket[0].matches.length, 1);

    completeRound(t, 2);
    generateNextPoolsKnockoutRound(t); // round 3: bye winner vs round-2 winner
    assert.equal(t.challenges.filter((c) => c.round === 3).length, 1);
  });
});
