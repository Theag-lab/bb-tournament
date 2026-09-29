import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNafExport } from './naf';
import { DEFAULT_INDIVIDUAL_SCORING } from './scoring';
import { DEFAULT_MATCH_SHEET_CONFIG, DEFAULT_ROUND_TIMER, type Challenge, type MatchResult, type Team, type Tournament } from './types';

function baseTournament(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't1',
    name: 'Coupe de Test',
    description: '',
    organizerCoachName: 'Jean Organisateur',
    requireRosterValidation: false,
    requireResultConfirmation: true,
    showTeamNames: true,
    mode: 'ladder',
    roundCount: null,
    rounds: [],
    format: 'individual',
    squadSize: null,
    squadScoring: null,
    squads: [],
    poolSize: null,
    poolRoundCount: null,
    qualifiersPerPool: null,
    pools: [],
    knockoutSeeds: null,
    individualScoring: DEFAULT_INDIVIDUAL_SCORING,
    matchSheetConfig: DEFAULT_MATCH_SHEET_CONFIG,
    customStatCategories: [],
    roundTimer: DEFAULT_ROUND_TIMER,
    adminToken: 'admin-token',
    createdAt: '2026-01-01T00:00:00.000Z',
    teams: [],
    challenges: [],
    ...overrides,
  };
}

function team(overrides: Partial<Team> = {}): Team {
  return {
    id: overrides.id ?? 'team-id',
    password: 'password123',
    name: overrides.coachName ?? 'Team',
    coachName: 'Coach',
    race: 'Orc',
    nafNumber: null,
    squadId: null,
    poolId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    rosterImage: null,
    rosterStatus: 'created',
    ...overrides,
  };
}

function matchResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    playedAt: '2026-01-01',
    team1Td: 1,
    team2Td: 0,
    team1Cas: 0,
    team2Cas: 0,
    team1Agg: 0,
    team2Agg: 0,
    customStats: {},
    concededByTeamId: null,
    team1Points: 5,
    team2Points: 0,
    submittedByTeamId: 't1',
    submittedAt: '2026-01-01T00:00:00.000Z',
    confirmedByTeamId: 't2',
    completedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function completedChallenge(team1Id: string, team2Id: string, result: Partial<MatchResult> = {}): Challenge {
  return {
    id: `${team1Id}-vs-${team2Id}`,
    team1Id,
    team2Id,
    status: 'completed',
    round: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    result: matchResult(result),
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

describe('buildNafExport — non-NAF opponents (generic coach #9)', () => {
  test('a match between two NAF-registered coaches is exported unchanged, no generic coach added', () => {
    const t1 = team({ id: 't1', coachName: 'Alice', race: 'Orc', nafNumber: '111' });
    const t2 = team({ id: 't2', coachName: 'Bob', race: 'Dwarf', nafNumber: '222' });
    const xml = buildNafExport(
      baseTournament({ teams: [t1, t2], challenges: [completedChallenge('t1', 't2')] })
    );
    assert.match(xml, /<name>Alice<\/name><number>111<\/number>/);
    assert.match(xml, /<name>Bob<\/name><number>222<\/number>/);
    assert.doesNotMatch(xml, /non-NAF/);
  });

  test('a match between two non-NAF coaches has nothing to report and is dropped entirely', () => {
    const t1 = team({ id: 't1', coachName: 'Alice', nafNumber: null });
    const t2 = team({ id: 't2', coachName: 'Bob', nafNumber: null });
    const xml = buildNafExport(
      baseTournament({ teams: [t1, t2], challenges: [completedChallenge('t1', 't2')] })
    );
    assert.doesNotMatch(xml, /<game>/);
    assert.doesNotMatch(xml, /non-NAF/);
  });

  test('a NAF coach vs a non-NAF coach is exported, the non-NAF side reported as the generic coach #9', () => {
    const naf = team({ id: 't1', coachName: 'Alice', race: 'Orc', nafNumber: '111' });
    const nonNaf = team({ id: 't2', coachName: 'Bob', race: 'Dwarf', nafNumber: null });
    const xml = buildNafExport(
      baseTournament({
        teams: [naf, nonNaf],
        challenges: [completedChallenge('t1', 't2', { team1Td: 2, team2Td: 1 })],
      })
    );
    // Real NAF coach untouched.
    assert.match(xml, /<coach><name>Alice<\/name><number>111<\/number><team>Orc<\/team><\/coach>/);
    // Generic coach declared once, with the actual (single) non-NAF opponent's race.
    assert.match(xml, /<coach><name>non-NAF<\/name><number>9<\/number><team>Dwarf<\/team><\/coach>/);
    // The game itself is exported (not dropped), with real stats but the generic identity for Bob.
    assert.match(xml, /<game>/);
    assert.match(xml, /<name>non-NAF<\/name><number>9<\/number><teamRating>0<\/teamRating><touchDowns>1<\/touchDowns>/);
    assert.doesNotMatch(xml, /<name>Bob<\/name>/);
  });

  test('multiple non-NAF opponents with the same race are declared under that one race, not Multi-race', () => {
    const naf1 = team({ id: 'n1', coachName: 'Alice', race: 'Orc', nafNumber: '111' });
    const naf2 = team({ id: 'n2', coachName: 'Carl', race: 'Human', nafNumber: '333' });
    const nonNaf1 = team({ id: 'x1', coachName: 'Bob', race: 'Dwarf', nafNumber: null });
    const nonNaf2 = team({ id: 'x2', coachName: 'Dan', race: 'Dwarf', nafNumber: null });
    const xml = buildNafExport(
      baseTournament({
        teams: [naf1, naf2, nonNaf1, nonNaf2],
        challenges: [completedChallenge('n1', 'x1'), completedChallenge('n2', 'x2')],
      })
    );
    assert.match(xml, /<coach><name>non-NAF<\/name><number>9<\/number><team>Dwarf<\/team><\/coach>/);
    assert.doesNotMatch(xml, /Multi-race/);
    // Only one generic coach entry, even though two different non-NAF teams used it.
    assert.equal((xml.match(/<name>non-NAF<\/name>/g) ?? []).length, 3); // 1 in <coaches> + 2 playerRecords
  });

  test('non-NAF opponents with different races are declared as Multi-race', () => {
    const naf1 = team({ id: 'n1', coachName: 'Alice', race: 'Orc', nafNumber: '111' });
    const naf2 = team({ id: 'n2', coachName: 'Carl', race: 'Human', nafNumber: '333' });
    const nonNaf1 = team({ id: 'x1', coachName: 'Bob', race: 'Dwarf', nafNumber: null });
    const nonNaf2 = team({ id: 'x2', coachName: 'Dan', race: 'Skaven', nafNumber: null });
    const xml = buildNafExport(
      baseTournament({
        teams: [naf1, naf2, nonNaf1, nonNaf2],
        challenges: [completedChallenge('n1', 'x1'), completedChallenge('n2', 'x2')],
      })
    );
    assert.match(xml, /<coach><name>non-NAF<\/name><number>9<\/number><team>Multi-race<\/team><\/coach>/);
  });

  test('no generic coach is added when every match is either fully NAF or fully non-NAF', () => {
    const naf1 = team({ id: 'n1', coachName: 'Alice', nafNumber: '111' });
    const naf2 = team({ id: 'n2', coachName: 'Carl', nafNumber: '333' });
    const nonNaf1 = team({ id: 'x1', coachName: 'Bob', nafNumber: null });
    const nonNaf2 = team({ id: 'x2', coachName: 'Dan', nafNumber: null });
    const xml = buildNafExport(
      baseTournament({
        teams: [naf1, naf2, nonNaf1, nonNaf2],
        challenges: [completedChallenge('n1', 'n2'), completedChallenge('x1', 'x2')],
      })
    );
    assert.doesNotMatch(xml, /non-NAF/);
  });
});
