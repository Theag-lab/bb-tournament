import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnockoutSeeds, computeByeCount, getKnockoutWinner, pairFirstKnockoutRound } from './bracket';
import type { Challenge, MatchResult } from './types';

describe('computeByeCount', () => {
  test('exact power of two needs no byes', () => {
    assert.equal(computeByeCount(8), 0);
    assert.equal(computeByeCount(1), 0);
  });

  test('pads up to the next power of two', () => {
    assert.equal(computeByeCount(5), 3);
    assert.equal(computeByeCount(6), 2);
    assert.equal(computeByeCount(9), 7);
  });

  test('non-positive counts need no byes', () => {
    assert.equal(computeByeCount(0), 0);
  });
});

describe('buildKnockoutSeeds', () => {
  test('groups by finishing tier across pools, in pool order', () => {
    const seeds = buildKnockoutSeeds([
      { poolId: 'A', teamIds: ['a1', 'a2'] },
      { poolId: 'B', teamIds: ['b1', 'b2'] },
    ]);
    assert.deepEqual(seeds, ['a1', 'b1', 'a2', 'b2']);
  });

  test('handles uneven qualifier counts per pool', () => {
    const seeds = buildKnockoutSeeds([
      { poolId: 'A', teamIds: ['a1', 'a2'] },
      { poolId: 'B', teamIds: ['b1'] },
    ]);
    assert.deepEqual(seeds, ['a1', 'b1', 'a2']);
  });
});

describe('pairFirstKnockoutRound', () => {
  test('no byes needed for a power-of-two seed count, high vs low pairing', () => {
    const poolOfTeam = new Map([
      ['s1', 'A'],
      ['s2', 'B'],
      ['s3', 'C'],
      ['s4', 'D'],
    ]);
    const { byes, pairs } = pairFirstKnockoutRound(['s1', 's2', 's3', 's4'], poolOfTeam);
    assert.deepEqual(byes, []);
    assert.deepEqual(pairs, [
      ['s1', 's4'],
      ['s2', 's3'],
    ]);
  });

  test('top seeds get byes when padding is needed', () => {
    const poolOfTeam = new Map([
      ['s1', 'A'],
      ['s2', 'B'],
      ['s3', 'C'],
    ]);
    const { byes, pairs } = pairFirstKnockoutRound(['s1', 's2', 's3'], poolOfTeam);
    assert.deepEqual(byes, ['s1']);
    assert.deepEqual(pairs, [['s2', 's3']]);
  });

  test('swaps to avoid an immediate same-pool rematch when a fix is available', () => {
    // High-vs-low would naturally pair a1 vs a2 (same pool) here; a swap with the other pair
    // should break that up since a1/b1 and a2/b2 are cross-pool.
    const poolOfTeam = new Map([
      ['a1', 'A'],
      ['a2', 'A'],
      ['b1', 'B'],
      ['b2', 'B'],
    ]);
    const { pairs } = pairFirstKnockoutRound(['a1', 'a2', 'b1', 'b2'], poolOfTeam);
    for (const [x, y] of pairs) {
      assert.notEqual(poolOfTeam.get(x), poolOfTeam.get(y));
    }
  });
});

function result(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    playedAt: '2026-01-01',
    team1Td: 0,
    team2Td: 0,
    team1Cas: 0,
    team2Cas: 0,
    team1Agg: 0,
    team2Agg: 0,
    concededByTeamId: null,
    team1Points: 0,
    team2Points: 0,
    submittedByTeamId: 't1',
    submittedAt: '2026-01-01T00:00:00.000Z',
    confirmedByTeamId: null,
    completedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function priorChallenge(team1Id: string, team2Id: string, r: Partial<MatchResult>): Challenge {
  return {
    id: `${team1Id}-vs-${team2Id}`,
    team1Id,
    team2Id,
    status: 'completed',
    round: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    result: result(r),
  };
}

describe('getKnockoutWinner', () => {
  test('decisive TD difference wins outright', () => {
    const winner = getKnockoutWinner(result({ team1Td: 3, team2Td: 1 }), 't1', 't2', []);
    assert.equal(winner, 't1');
  });

  test('TD tie falls through to net_cas when configured', () => {
    const winner = getKnockoutWinner(
      result({ team1Td: 2, team2Td: 2, team1Cas: 3, team2Cas: 1 }),
      't1',
      't2',
      ['fewest_td_conceded', 'net_td', 'net_cas']
    );
    assert.equal(winner, 't1');
  });

  test('TD tie skips criteria with no single-match meaning and falls to net_agg', () => {
    const winner = getKnockoutWinner(
      result({ team1Td: 2, team2Td: 2, team1Cas: 1, team2Cas: 1, team1Agg: 0, team2Agg: 4 }),
      't1',
      't2',
      ['opponent_score', 'net_cas', 'net_agg']
    );
    assert.equal(winner, 't2');
  });

  test('always produces a winner even with no discriminating tiebreakers', () => {
    const winner = getKnockoutWinner(result({ team1Td: 1, team2Td: 1 }), 't1', 't2', []);
    assert.ok(winner === 't1' || winner === 't2');
  });

  test('tie resolution is deterministic across repeated calls', () => {
    const r = result({ team1Td: 1, team2Td: 1 });
    const first = getKnockoutWinner(r, 't1', 't2', []);
    const second = getKnockoutWinner(r, 't1', 't2', []);
    assert.equal(first, second);
  });

  test('TD tie is resolved by head_to_head using an earlier meeting (e.g. the pool phase)', () => {
    const priorMeetings = [priorChallenge('t1', 't2', { team1Td: 3, team2Td: 1 })];
    const winner = getKnockoutWinner(
      result({ team1Td: 2, team2Td: 2 }),
      't1',
      't2',
      ['head_to_head'],
      priorMeetings
    );
    assert.equal(winner, 't1');
  });

  test('head_to_head falls through to the next criterion when the pair never met before', () => {
    const winner = getKnockoutWinner(
      result({ team1Td: 2, team2Td: 2, team1Cas: 1, team2Cas: 0 }),
      't1',
      't2',
      ['head_to_head', 'net_cas'],
      []
    );
    assert.equal(winner, 't1');
  });

  test('the current tied match itself never counts as head-to-head signal (it is a draw by definition)', () => {
    // Only prior challenge supplied is the match being resolved right now, already tied 2-2 — it
    // must not spuriously "decide" anything, so this falls through to net_cas.
    const currentMatch = priorChallenge('t1', 't2', { team1Td: 2, team2Td: 2, team1Cas: 5, team2Cas: 0 });
    const winner = getKnockoutWinner(
      currentMatch.result!,
      't1',
      't2',
      ['head_to_head', 'net_cas'],
      [currentMatch]
    );
    assert.equal(winner, 't1');
  });
});
