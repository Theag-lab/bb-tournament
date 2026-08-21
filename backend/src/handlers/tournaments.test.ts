import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INDIVIDUAL_SCORING, ORGANIZER_COACH_NAME_MAX_LENGTH, type IndividualScoringConfig } from '@bb-tournament/shared';
import { mergeIndividualScoring, validateOrganizerCoachName } from './tournaments';
import { AppError } from '../errors';

describe('validateOrganizerCoachName', () => {
  test('trims and accepts a valid name', () => {
    assert.equal(validateOrganizerCoachName('  Léon  '), 'Léon');
  });

  test('rejects a missing or empty name', () => {
    assert.throws(() => validateOrganizerCoachName(undefined), AppError);
    assert.throws(() => validateOrganizerCoachName(null), AppError);
    assert.throws(() => validateOrganizerCoachName('   '), AppError);
  });

  test('rejects a name over the max length', () => {
    assert.throws(() => validateOrganizerCoachName('a'.repeat(ORGANIZER_COACH_NAME_MAX_LENGTH + 1)), AppError);
  });

  test('accepts a name exactly at the max length', () => {
    const name = 'a'.repeat(ORGANIZER_COACH_NAME_MAX_LENGTH);
    assert.equal(validateOrganizerCoachName(name), name);
  });
});

describe('mergeIndividualScoring', () => {
  test('returns the base config unchanged when given no override', () => {
    const merged = mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, null);
    assert.deepEqual(merged, DEFAULT_INDIVIDUAL_SCORING);
  });

  test('applies a partial override on top of the base', () => {
    const merged = mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { pointsWin: 10 });
    assert.equal(merged.pointsWin, 10);
    assert.equal(merged.pointsDraw, DEFAULT_INDIVIDUAL_SCORING.pointsDraw);
  });

  test('rejects an invalid mode', () => {
    assert.throws(
      () => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { mode: 'not_a_mode' as IndividualScoringConfig['mode'] }),
      AppError
    );
  });

  test('rejects non-integer or out-of-range point values', () => {
    assert.throws(() => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { pointsWin: 1.5 }), AppError);
    assert.throws(() => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { pointsWin: 100000 }), AppError);
    assert.throws(() => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { pointsWin: 'five' as unknown as number }), AppError);
  });

  test('rejects an unknown tiebreaker criterion', () => {
    assert.throws(
      () => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { tiebreakers: ['not_real'] as unknown as never[] }),
      AppError
    );
  });

  test('accepts an empty tiebreakers list', () => {
    const merged = mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { tiebreakers: [] });
    assert.deepEqual(merged.tiebreakers, []);
  });

  test('rejects a raw-points component with an invalid basis', () => {
    assert.throws(
      () => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { td: { basis: 'percent' as any, multiplier: 1 } }),
      AppError
    );
  });

  test('rejects a raw-points component missing entirely', () => {
    assert.throws(() => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { td: null as any }), AppError);
  });

  test('rejects a multiplier outside the allowed range', () => {
    assert.throws(
      () => mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, { td: { basis: 'total', multiplier: 99999 } }),
      AppError
    );
  });

  test('accepts a fully-specified raw_points config (400 pts win + 3 pts/TD)', () => {
    const merged = mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, {
      mode: 'raw_points',
      pointsWin: 400,
      pointsDraw: 100,
      td: { basis: 'total', multiplier: 3 },
    });
    assert.equal(merged.mode, 'raw_points');
    assert.equal(merged.pointsWin, 400);
    assert.equal(merged.td.multiplier, 3);
  });
});
