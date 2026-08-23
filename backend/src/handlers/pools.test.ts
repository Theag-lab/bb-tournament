import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computePoolAssignment } from './pools';

function teamIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `team-${i}`);
}

describe('computePoolAssignment', () => {
  test('every team is assigned to exactly one pool', () => {
    const ids = teamIds(10);
    const pools = computePoolAssignment(ids, 4);
    const flat = pools.flat();
    assert.equal(flat.length, ids.length);
    assert.deepEqual(new Set(flat), new Set(ids));
  });

  test('pool count is close to teamCount / poolSize', () => {
    // 10 teams at target size 4 -> round(2.5) = 3 pools (closer to size 4 than 2 pools of 5 would be)
    const pools = computePoolAssignment(teamIds(10), 4);
    assert.equal(pools.length, 3);
  });

  test('exact multiples split evenly', () => {
    const pools = computePoolAssignment(teamIds(12), 4);
    assert.equal(pools.length, 3);
    for (const pool of pools) assert.equal(pool.length, 4);
  });

  test('pool sizes never differ by more than one', () => {
    const pools = computePoolAssignment(teamIds(11), 4);
    const sizes = pools.map((p) => p.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  });

  test('never produces zero pools, even for a tiny team count', () => {
    const pools = computePoolAssignment(teamIds(2), 4);
    assert.equal(pools.length, 1);
    assert.equal(pools[0].length, 2);
  });
});
