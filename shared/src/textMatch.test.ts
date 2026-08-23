import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { jaroWinklerSimilarity, matchRace } from './textMatch';

describe('jaroWinklerSimilarity', () => {
  test('identical strings score 1', () => {
    assert.equal(jaroWinklerSimilarity('human', 'human'), 1);
  });

  test('completely unrelated strings score low', () => {
    assert.ok(jaroWinklerSimilarity('human', 'zzzzz') < 0.5);
  });

  test('shared prefix boosts the score over plain Jaro', () => {
    const withPrefix = jaroWinklerSimilarity('skaven', 'skavenn');
    const noPrefix = jaroWinklerSimilarity('skaven', 'nnevaks');
    assert.ok(withPrefix > noPrefix);
  });

  test('empty strings are handled without throwing', () => {
    assert.equal(jaroWinklerSimilarity('', ''), 1);
    assert.equal(jaroWinklerSimilarity('', 'human'), 0);
  });
});

describe('matchRace', () => {
  test('matches an exact race name case-insensitively', () => {
    const match = matchRace('human');
    assert.equal(match?.race, 'Human');
    assert.equal(match?.score, 1);
  });

  test('matches a close typo', () => {
    const match = matchRace('Skavven');
    assert.equal(match?.race, 'Skaven');
  });

  test('matches despite surrounding whitespace', () => {
    const match = matchRace('  Orc  ');
    assert.equal(match?.race, 'Orc');
  });

  test('returns null for an empty input', () => {
    assert.equal(matchRace(''), null);
    assert.equal(matchRace('   '), null);
  });

  test('returns null for an unrecognisable input below the threshold', () => {
    assert.equal(matchRace('xyzxyzxyz not a race'), null);
  });

  test('a stricter threshold rejects a match a looser one accepts', () => {
    const loose = matchRace('Orcz', 0.5);
    const strict = matchRace('Orcz', 0.99);
    assert.ok(loose !== null);
    assert.equal(strict, null);
  });
});
