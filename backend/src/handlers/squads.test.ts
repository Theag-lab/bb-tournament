import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SQUAD_SCORING } from '@bb-tournament/shared';
import { mergeSquadScoring } from './squads';
import { AppError } from '../errors';

describe('mergeSquadScoring', () => {
  test('returns the base config unchanged when given no override', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, null);
    assert.deepEqual(merged, DEFAULT_SQUAD_SCORING);
  });

  test('applies a partial override on top of the base', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, { pointsBigWin: 10 });
    assert.equal(merged.pointsBigWin, 10);
    assert.equal(merged.pointsWin, DEFAULT_SQUAD_SCORING.pointsWin);
  });

  test('rejects bigMarginMinDiff that is not strictly greater than smallMarginMaxDiff', () => {
    assert.throws(
      () => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { smallMarginMaxDiff: 3, bigMarginMinDiff: 3 }),
      AppError
    );
    assert.throws(
      () => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { smallMarginMaxDiff: 3, bigMarginMinDiff: 2 }),
      AppError
    );
  });

  test('accepts bigMarginMinDiff exactly one above smallMarginMaxDiff', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, { smallMarginMaxDiff: 1, bigMarginMinDiff: 2 });
    assert.equal(merged.smallMarginMaxDiff, 1);
    assert.equal(merged.bigMarginMinDiff, 2);
  });

  test('rejects a negative point value on any tier', () => {
    assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { pointsSmallLoss: -1 }), AppError);
  });

  test('rejects a non-integer point value', () => {
    assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { pointsDraw: 1.5 }), AppError);
  });

  test('rejects a non-integer smallMarginMaxDiff', () => {
    assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { smallMarginMaxDiff: 0 }), AppError);
  });

  test('fills in the default tiebreakers for a stored config that predates them', () => {
    const { tiebreakers: _omitted, ...legacy } = DEFAULT_SQUAD_SCORING;
    assert.deepEqual(mergeSquadScoring(legacy, null).tiebreakers, DEFAULT_SQUAD_SCORING.tiebreakers);
  });

  test('accepts the squad-only member_points tiebreaker', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, { tiebreakers: ['member_points', 'net_td'] });
    assert.deepEqual(merged.tiebreakers, ['member_points', 'net_td']);
  });

  test('accepts the squad head_to_head tiebreaker', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, { tiebreakers: ['head_to_head'] });
    assert.deepEqual(merged.tiebreakers, ['head_to_head']);
  });

  test('rejects unknown, individual-only or duplicate tiebreakers', () => {
    const bad = [['fewest_cas'], ['custom:x'], ['net_td', 'net_td'], 'net_td'];
    for (const tiebreakers of bad) {
      assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { tiebreakers } as never), AppError);
    }
  });
});
