import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { roundRobinPairingForRound, roundRobinSchedule, stableShuffledOrder } from './roundRobin';

function everyPairOnce(rounds: [string, string][][]): Set<string> {
  const seen = new Set<string>();
  for (const round of rounds) {
    for (const [a, b] of round) {
      const key = [a, b].sort().join('|');
      assert.ok(!seen.has(key), `pair ${key} repeated across rounds`);
      seen.add(key);
    }
  }
  return seen;
}

describe('roundRobinSchedule', () => {
  test('even count: N-1 rounds, every team plays every other exactly once, no byes', () => {
    const teams = ['a', 'b', 'c', 'd'];
    const rounds = roundRobinSchedule(teams);
    assert.equal(rounds.length, 3);
    for (const round of rounds) assert.equal(round.length, 2);
    const seenPairs = everyPairOnce(rounds);
    assert.equal(seenPairs.size, 6); // C(4,2)
  });

  test('odd count: one team sits out each round, rotating, no repeats', () => {
    const teams = ['a', 'b', 'c'];
    const rounds = roundRobinSchedule(teams);
    assert.equal(rounds.length, 3); // padded to 4 -> 3 rounds
    for (const round of rounds) assert.equal(round.length, 1); // one pair, one bye per round

    const seenPairs = everyPairOnce(rounds);
    assert.equal(seenPairs.size, 3); // C(3,2)

    // Every team plays in exactly 2 of the 3 rounds (sits out exactly once).
    const appearances = new Map<string, number>();
    for (const round of rounds) {
      for (const [a, b] of round) {
        appearances.set(a, (appearances.get(a) ?? 0) + 1);
        appearances.set(b, (appearances.get(b) ?? 0) + 1);
      }
    }
    for (const team of teams) assert.equal(appearances.get(team), 2);
  });

  test('every team faces every other exactly once for a larger even pool', () => {
    const teams = Array.from({ length: 8 }, (_, i) => `t${i}`);
    const rounds = roundRobinSchedule(teams);
    assert.equal(rounds.length, 7);
    const seenPairs = everyPairOnce(rounds);
    assert.equal(seenPairs.size, 28); // C(8,2)
  });

  test('fewer than 2 teams produces no rounds', () => {
    assert.deepEqual(roundRobinSchedule([]), []);
    assert.deepEqual(roundRobinSchedule(['a']), []);
  });

  test('is a pure function of team membership — same input, same output', () => {
    const teams = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(roundRobinSchedule(teams), roundRobinSchedule(teams));
  });
});

describe('stableShuffledOrder', () => {
  test('is a permutation of the input, deterministic across calls', () => {
    const teams = ['a', 'b', 'c', 'd', 'e'];
    const first = stableShuffledOrder(teams);
    const second = stableShuffledOrder(teams);
    assert.deepEqual([...first].sort(), [...teams].sort());
    assert.deepEqual(first, second);
  });
});

describe('roundRobinPairingForRound', () => {
  test('round N matches schedule index N-1', () => {
    const teams = ['a', 'b', 'c', 'd'];
    const schedule = roundRobinSchedule(stableShuffledOrder(teams));
    assert.deepEqual(roundRobinPairingForRound(teams, 1), schedule[0]);
    assert.deepEqual(roundRobinPairingForRound(teams, 3), schedule[2]);
  });

  test('does not depend on any prior round having been generated — every round is independently computable', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'];
    // Request round 4 directly, with no knowledge of rounds 1-3, and round 1 in any order.
    const round4 = roundRobinPairingForRound(teams, 4);
    const round1 = roundRobinPairingForRound(teams, 1);
    assert.ok(round4.length > 0);
    assert.ok(round1.length > 0);
    // Re-requesting the same round again gives the identical pairing (idempotent, no persisted state).
    assert.deepEqual(roundRobinPairingForRound(teams, 4), round4);
  });

  test('cycles back through the schedule once every pairing has been used', () => {
    const teams = ['a', 'b', 'c', 'd'];
    const scheduleLength = roundRobinSchedule(stableShuffledOrder(teams)).length; // 3
    assert.deepEqual(roundRobinPairingForRound(teams, 1), roundRobinPairingForRound(teams, 1 + scheduleLength));
  });

  test('empty for fewer than 2 teams', () => {
    assert.deepEqual(roundRobinPairingForRound(['a'], 1), []);
  });
});
