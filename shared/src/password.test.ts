import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_PASSWORD_MAX_LENGTH, TEAM_PASSWORD_MIN_LENGTH } from './types';
import { derivePasswordFromCoachName } from './password';

describe('derivePasswordFromCoachName', () => {
  test('uses the coach name as-is when already within bounds', () => {
    assert.equal(derivePasswordFromCoachName('Jean Dupont'), 'Jean Dupont');
  });

  test('pads a too-short coach name up to the minimum length', () => {
    const password = derivePasswordFromCoachName('Al');
    assert.ok(password.length >= TEAM_PASSWORD_MIN_LENGTH);
    assert.equal(password, 'AlAl');
  });

  test('truncates a too-long coach name down to the maximum length', () => {
    const longName = 'A'.repeat(TEAM_PASSWORD_MAX_LENGTH + 20);
    const password = derivePasswordFromCoachName(longName);
    assert.equal(password.length, TEAM_PASSWORD_MAX_LENGTH);
  });
});
