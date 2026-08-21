import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNafExport } from './naf';
import { DEFAULT_INDIVIDUAL_SCORING } from './scoring';
import type { Tournament } from './types';

function baseTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't1',
    name: 'Coupe de Test',
    description: '',
    organizerCoachName: 'Jean Organisateur',
    requireRosterValidation: false,
    mode: 'ladder',
    roundCount: null,
    rounds: [],
    format: 'individual',
    squadSize: null,
    squadScoring: null,
    squads: [],
    individualScoring: DEFAULT_INDIVIDUAL_SCORING,
    adminToken: 'admin-token',
    createdAt: '2026-01-01T00:00:00.000Z',
    teams: [],
    challenges: [],
    ...overrides,
  };
}

describe('buildNafExport — <organiser>', () => {
  test('uses organizerCoachName, not the tournament name', () => {
    const xml = buildNafExport(baseTournament());
    assert.match(xml, /<organiser>Jean Organisateur<\/organiser>/);
    assert.doesNotMatch(xml, /<organiser>Coupe de Test<\/organiser>/);
  });

  test('escapes XML-special characters in the organiser name', () => {
    const xml = buildNafExport(baseTournament({ organizerCoachName: 'Jean & "Bob" <TD>' }));
    assert.match(xml, /<organiser>Jean &amp; &quot;Bob&quot; &lt;TD&gt;<\/organiser>/);
  });

  test('falls back to the tournament name for legacy data missing organizerCoachName', () => {
    const xml = buildNafExport(baseTournament({ organizerCoachName: '' as unknown as string }));
    assert.match(xml, /<organiser>Coupe de Test<\/organiser>/);
  });
});
