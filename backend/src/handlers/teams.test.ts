import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePasswordFromCoachName, type Squad, type Team } from '@bb-tournament/shared';
import { prepareImportedTeams } from './teams';

function existingTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 't1',
    password: 'password123',
    name: 'Existing',
    coachName: 'Existing Coach',
    race: 'Human',
    nafNumber: null,
    squadId: null,
    poolId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    rosterImage: null,
    rosterStatus: 'created',
    ...overrides,
  };
}

describe('prepareImportedTeams', () => {
  test('prepares valid rows with team name = coach name and a matched race', () => {
    const { errors, teams } = prepareImportedTeams([], [{ coachName: 'Jean Dupont', race: 'human' }]);
    assert.deepEqual(errors, []);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].name, 'Jean Dupont');
    assert.equal(teams[0].coachName, 'Jean Dupont');
    assert.equal(teams[0].race, 'Human');
    assert.equal(teams[0].password, derivePasswordFromCoachName('Jean Dupont'));
    assert.equal(teams[0].squadId, null);
    assert.equal(teams[0].poolId, null);
  });

  test('accepts a valid NAF number', () => {
    const { errors, teams } = prepareImportedTeams([], [{ coachName: 'Jean', race: 'Orc', nafNumber: '12345' }]);
    assert.deepEqual(errors, []);
    assert.equal(teams[0].nafNumber, '12345');
  });

  test('rejects a malformed NAF number', () => {
    const { errors } = prepareImportedTeams([], [{ coachName: 'Jean', race: 'Orc', nafNumber: 'abc' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /NAF/);
  });

  test('flags a missing coach name', () => {
    const { errors, teams } = prepareImportedTeams([], [{ coachName: '  ', race: 'Human' }]);
    assert.equal(errors.length, 1);
    assert.equal(teams.length, 0);
  });

  test('flags a missing race', () => {
    const { errors } = prepareImportedTeams([], [{ coachName: 'Jean', race: '' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /race/i);
  });

  test('flags a race that does not resolve via fuzzy matching', () => {
    const { errors } = prepareImportedTeams([], [{ coachName: 'Jean', race: 'totally not a race' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /non reconnue/);
  });

  test('flags a duplicate coach name within the same batch', () => {
    const { errors, teams } = prepareImportedTeams(
      [],
      [
        { coachName: 'Jean Dupont', race: 'Human' },
        { coachName: 'jean dupont', race: 'Orc' },
      ]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /double/);
    assert.equal(teams.length, 1);
  });

  test('flags a coach already registered with the same derived password', () => {
    const password = derivePasswordFromCoachName('Jean Dupont');
    const { errors } = prepareImportedTeams(
      [existingTeam({ coachName: 'Jean Dupont', password })],
      [{ coachName: 'Jean Dupont', race: 'Human' }]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /déjà inscrit/);
  });

  test('does not flag a coach name that collides only in password with an unrelated existing team', () => {
    const { errors, teams } = prepareImportedTeams(
      [existingTeam({ coachName: 'Jean Dupont', password: 'some-other-password' })],
      [{ coachName: 'Jean Dupont', race: 'Human' }]
    );
    // Same app semantics as single-team registration: coachName + password is the identity pair,
    // so a different password for the same coach name is allowed to coexist.
    assert.deepEqual(errors, []);
    assert.equal(teams.length, 1);
  });

  test('flags a team name collision against an existing team', () => {
    const { errors } = prepareImportedTeams(
      [existingTeam({ name: 'Marc Martin' })],
      [{ coachName: 'Marc Martin', race: 'Human' }]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /nom d'équipe/);
  });

  test('collects every row error rather than stopping at the first', () => {
    const { errors } = prepareImportedTeams(
      [],
      [
        { coachName: '', race: 'Human' },
        { coachName: 'Jean', race: '' },
      ]
    );
    assert.equal(errors.length, 2);
  });

  test('individual format ignores any squadName entirely', () => {
    const { errors, teams } = prepareImportedTeams(
      [],
      [{ squadName: 'Titans', coachName: 'Jean', race: 'Human' }],
      { format: 'individual' }
    );
    assert.deepEqual(errors, []);
    assert.equal(teams[0].squadId, null);
  });
});

describe('prepareImportedTeams — team format squad assignment', () => {
  test('requires a squadName', () => {
    const { errors } = prepareImportedTeams([], [{ coachName: 'Jean', race: 'Human' }], { format: 'team' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /escouade/);
  });

  test('creates a new squad for an unrecognised squad name', () => {
    const { errors, teams, newSquads } = prepareImportedTeams(
      [],
      [{ squadName: 'Titans', coachName: 'Jean', race: 'Human' }],
      { format: 'team' }
    );
    assert.deepEqual(errors, []);
    assert.equal(newSquads.length, 1);
    assert.equal(newSquads[0].name, 'Titans');
    assert.equal(teams[0].squadId, newSquads[0].id);
  });

  test('groups multiple rows naming the same new squad together, case-insensitively', () => {
    const { errors, teams, newSquads } = prepareImportedTeams(
      [],
      [
        { squadName: 'Titans', coachName: 'Jean', race: 'Human' },
        { squadName: 'titans', coachName: 'Marie', race: 'Orc' },
      ],
      { format: 'team' }
    );
    assert.deepEqual(errors, []);
    assert.equal(newSquads.length, 1);
    assert.equal(teams[0].squadId, teams[1].squadId);
  });

  test('joins an existing squad by name, case-insensitively, instead of creating a duplicate', () => {
    const existingSquad: Squad = { id: 'sq1', name: 'Titans', createdAt: '2026-01-01T00:00:00.000Z' };
    const { errors, teams, newSquads } = prepareImportedTeams(
      [],
      [{ squadName: 'TITANS', coachName: 'Jean', race: 'Human' }],
      { format: 'team', existingSquads: [existingSquad] }
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(newSquads, []);
    assert.equal(teams[0].squadId, 'sq1');
  });

  test('rejects a row once its squad is full, counting existing members plus the batch', () => {
    const existingSquad: Squad = { id: 'sq1', name: 'Titans', createdAt: '2026-01-01T00:00:00.000Z' };
    const existing = [existingTeam({ id: 'e1', squadId: 'sq1', coachName: 'Already Here' })];
    const { errors, teams } = prepareImportedTeams(
      existing,
      [
        { squadName: 'Titans', coachName: 'Jean', race: 'Human' },
        { squadName: 'Titans', coachName: 'Marie', race: 'Orc' },
      ],
      { format: 'team', existingSquads: [existingSquad], squadSize: 2 }
    );
    // Squad already has 1 member; only 1 more slot — the second row should be rejected.
    assert.equal(errors.length, 1);
    assert.match(errors[0], /complète/);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].coachName, 'Jean');
  });

  test('an unlimited squadSize (null) never rejects for capacity', () => {
    const { errors, teams } = prepareImportedTeams(
      [],
      [
        { squadName: 'Titans', coachName: 'Jean', race: 'Human' },
        { squadName: 'Titans', coachName: 'Marie', race: 'Orc' },
        { squadName: 'Titans', coachName: 'Marc', race: 'Dwarf' },
      ],
      { format: 'team', squadSize: null }
    );
    assert.deepEqual(errors, []);
    assert.equal(teams.length, 3);
  });

  test('rejects an over-length squad name', () => {
    const { errors } = prepareImportedTeams(
      [],
      [{ squadName: 'x'.repeat(41), coachName: 'Jean', race: 'Human' }],
      { format: 'team' }
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /escouade/);
  });
});
