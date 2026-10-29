import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFumbblTracking } from './fumbbl';
import { AppError } from '../errors';

describe('validateFumbblTracking', () => {
  test('trims the tag', () => {
    assert.deepEqual(validateFumbblTracking({ enabled: true, tag: '  [LuteceWC2027] ' }), { enabled: true, tag: '[LuteceWC2027]' });
  });

  test('requires a tag to enable tracking, not to disable it', () => {
    assert.throws(() => validateFumbblTracking({ enabled: true, tag: '  ' }), AppError);
    assert.deepEqual(validateFumbblTracking({ enabled: false, tag: '' }), { enabled: false, tag: '' });
  });

  test('rejects a missing body or a non-boolean enabled', () => {
    assert.throws(() => validateFumbblTracking(null), AppError);
    assert.throws(() => validateFumbblTracking({ tag: 'x' } as never), AppError);
  });
});
