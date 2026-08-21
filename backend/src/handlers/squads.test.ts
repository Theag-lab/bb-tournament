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
});
