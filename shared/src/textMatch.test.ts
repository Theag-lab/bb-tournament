import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FRENCH_RACE_LABELS, jaroWinklerSimilarity, matchRace } from './textMatch';
import { RACES } from './types';

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

describe('matchRace — French roster labels', () => {
  test('every RACES entry has a French label, and every French label resolves back to its race', () => {
    for (const race of RACES) {
      const label = FRENCH_RACE_LABELS[race];
      assert.ok(label, `missing French label for ${race}`);
      const match = matchRace(label);
      assert.equal(match?.race, race, `"${label}" resolved to "${match?.race}" instead of "${race}"`);
      assert.equal(match?.score, 1);
    }
  });

  test('matches are accent- and case-insensitive', () => {
    assert.equal(matchRace('élue du chaos')?.race, 'Chaos Chosen');
    assert.equal(matchRace('ELUE DU CHAOS')?.race, 'Chaos Chosen');
    assert.equal(matchRace('Elue Du Chaos')?.race, 'Chaos Chosen'); // accent dropped entirely
  });

  test('tolerates a typo in a French label the same way it does for English', () => {
    const match = matchRace('Skaven'); // English already covered elsewhere; check a French typo too
    assert.equal(match?.race, 'Skaven');
    assert.equal(matchRace('Nain')?.race, 'Dwarf'); // "Nains" missing its final "s"
    assert.equal(matchRace('Gobelin')?.race, 'Goblins'); // "Gobelins" missing its final "s"
  });

  test('a French label never resolves to the wrong race', () => {
    assert.equal(matchRace('Orques')?.race, 'Orc');
    assert.equal(matchRace('Orques Noir')?.race, 'Black Orc');
    assert.notEqual(matchRace('Orques')?.race, matchRace('Orques Noir')?.race);
  });
});
