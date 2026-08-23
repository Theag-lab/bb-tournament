import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_ROUND_TIMER,
  MAX_ROUND_TIMER_SECONDS,
  MIN_ROUND_TIMER_SECONDS,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  type IndividualScoringConfig,
} from '@bb-tournament/shared';
import { computeNextRoundTimer, mergeIndividualScoring, resolvePoolsKnockoutConfig, validateOrganizerCoachName } from './tournaments';
import { AppError } from '../errors';

describe('resolvePoolsKnockoutConfig', () => {
  test('returns all-null for a non-pools_knockout mode, ignoring any body fields', () => {
    const config = resolvePoolsKnockoutConfig('swiss', { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 2 });
    assert.deepEqual(config, { poolSize: null, poolRoundCount: null, qualifiersPerPool: null });
  });

  test('accepts a valid pools_knockout configuration', () => {
    const config = resolvePoolsKnockoutConfig('pools_knockout', { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 2 });
    assert.deepEqual(config, { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 2 });
  });

  test('rejects a missing poolSize', () => {
    assert.throws(
      () => resolvePoolsKnockoutConfig('pools_knockout', { poolRoundCount: 3, qualifiersPerPool: 2 }),
      AppError
    );
  });

  test('rejects a missing poolRoundCount', () => {
    assert.throws(
      () => resolvePoolsKnockoutConfig('pools_knockout', { poolSize: 4, qualifiersPerPool: 2 }),
      AppError
    );
  });

  test('rejects qualifiersPerPool equal to poolSize', () => {
    assert.throws(
      () => resolvePoolsKnockoutConfig('pools_knockout', { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 4 }),
      AppError
    );
  });

  test('rejects qualifiersPerPool greater than poolSize', () => {
    assert.throws(
      () => resolvePoolsKnockoutConfig('pools_knockout', { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 5 }),
      AppError
    );
  });

  test('accepts qualifiersPerPool one below poolSize', () => {
    const config = resolvePoolsKnockoutConfig('pools_knockout', { poolSize: 4, poolRoundCount: 3, qualifiersPerPool: 3 });
    assert.equal(config.qualifiersPerPool, 3);
  });
});

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

describe('computeNextRoundTimer', () => {
  const fixedNow = () => '2026-08-21T12:00:00.000Z';

  test('leaves the state unchanged when the request is empty', () => {
    const next = computeNextRoundTimer(DEFAULT_ROUND_TIMER, null, fixedNow);
    assert.deepEqual(next, DEFAULT_ROUND_TIMER);
  });

  test('updates durationSeconds without touching startedAt', () => {
    const running = { durationSeconds: 9000, startedAt: '2026-08-21T10:00:00.000Z' };
    const next = computeNextRoundTimer(running, { durationSeconds: 1800 }, fixedNow);
    assert.equal(next.durationSeconds, 1800);
    assert.equal(next.startedAt, running.startedAt);
  });

  test('start sets startedAt to now, using the request duration if provided', () => {
    const next = computeNextRoundTimer(DEFAULT_ROUND_TIMER, { start: true, durationSeconds: 1800 }, fixedNow);
    assert.equal(next.startedAt, fixedNow());
    assert.equal(next.durationSeconds, 1800);
  });

  test('reset clears startedAt without requiring a duration change', () => {
    const running = { durationSeconds: 9000, startedAt: '2026-08-21T10:00:00.000Z' };
    const next = computeNextRoundTimer(running, { reset: true }, fixedNow);
    assert.equal(next.startedAt, null);
    assert.equal(next.durationSeconds, 9000);
  });

  test('rejects start and reset together', () => {
    assert.throws(() => computeNextRoundTimer(DEFAULT_ROUND_TIMER, { start: true, reset: true }, fixedNow), AppError);
  });

  test('rejects a duration outside the allowed range', () => {
    assert.throws(
      () => computeNextRoundTimer(DEFAULT_ROUND_TIMER, { durationSeconds: MIN_ROUND_TIMER_SECONDS - 1 }, fixedNow),
      AppError
    );
    assert.throws(
      () => computeNextRoundTimer(DEFAULT_ROUND_TIMER, { durationSeconds: MAX_ROUND_TIMER_SECONDS + 1 }, fixedNow),
      AppError
    );
  });

  test('rejects a non-integer duration', () => {
    assert.throws(() => computeNextRoundTimer(DEFAULT_ROUND_TIMER, { durationSeconds: 90.5 }, fixedNow), AppError);
  });

  test('accepts durations exactly at the bounds', () => {
    const min = computeNextRoundTimer(DEFAULT_ROUND_TIMER, { durationSeconds: MIN_ROUND_TIMER_SECONDS }, fixedNow);
    const max = computeNextRoundTimer(DEFAULT_ROUND_TIMER, { durationSeconds: MAX_ROUND_TIMER_SECONDS }, fixedNow);
    assert.equal(min.durationSeconds, MIN_ROUND_TIMER_SECONDS);
    assert.equal(max.durationSeconds, MAX_ROUND_TIMER_SECONDS);
  });
});
