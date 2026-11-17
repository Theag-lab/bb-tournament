import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SQUAD_SCORING, type SquadScoringConfig } from '@bb-tournament/shared';
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

  test('accepts and normalises big-win / small-loss board records', () => {
    const merged = mergeSquadScoring(DEFAULT_SQUAD_SCORING, {
      bonusTiers: true,
      bigWinOutcomes: ['5-0-0', '3-2-0', '05-0-0'],
      smallLossOutcomes: ['1-2-2'],
    });
    assert.equal(merged.bonusTiers, true);
    assert.deepEqual(merged.bigWinOutcomes, ['5-0-0', '3-2-0']);
    assert.deepEqual(merged.smallLossOutcomes, ['1-2-2']);
  });

  test('rejects board records on the wrong side or malformed', () => {
    const bad: Partial<SquadScoringConfig>[] = [
      { bigWinOutcomes: ['2-1-2'] },
      { bigWinOutcomes: ['1-2-2'] },
      { smallLossOutcomes: ['3-0-2'] },
      { bigWinOutcomes: ['5/0/0'] },
      { bigWinOutcomes: '5-0-0' as never },
    ];
    for (const partial of bad) assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, partial), AppError);
  });

  test('a stored board-diff config is turned into the simple system, keeping its win/draw/loss points', () => {
    const legacy = { smallMarginMaxDiff: 1, bigMarginMinDiff: 3, pointsBigWin: 5, pointsWin: 4, pointsSmallWin: 3, pointsDraw: 2, pointsSmallLoss: 1, pointsLoss: 0 };
    const merged = mergeSquadScoring(legacy as Partial<SquadScoringConfig>, null);
    assert.equal(merged.bonusTiers, false);
    assert.deepEqual([merged.pointsWin, merged.pointsDraw, merged.pointsLoss], [4, 2, 0]);
    assert.equal('smallMarginMaxDiff' in merged, false);
    assert.equal('pointsSmallWin' in merged, false);
  });

  test('rejects a negative point value on any tier', () => {
    assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { pointsSmallLoss: -1 }), AppError);
  });

  test('rejects a non-integer point value', () => {
    assert.throws(() => mergeSquadScoring(DEFAULT_SQUAD_SCORING, { pointsDraw: 1.5 }), AppError);
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
