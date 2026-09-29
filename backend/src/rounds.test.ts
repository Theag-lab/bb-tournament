import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_MATCH_SHEET_CONFIG,
  DEFAULT_ROUND_TIMER,
  type Challenge,
  type Pool,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';
import { generateNextRound, swapRoundMatches } from './rounds';
import { launchKnockoutPhase } from './bracket';

function team(id: string, poolId: string | null): Team {
  return {
    id,
    password: 'password123',
    name: id,
    coachName: id,
    race: 'Human',
    nafNumber: null,
    squadId: null,
    poolId,
    createdAt: '2026-01-01T00:00:00.000Z',
    rosterImage: null,
    rosterStatus: 'created',
  };
}

function pool(id: string, name: string): Pool {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z' };
}

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

function poolsKnockoutTournament(overrides: Partial<Tournament> = {}): Tournament {
  return baseTournament({
    mode: 'pools_knockout',
    poolSize: 2,
    poolRoundCount: 1,
    qualifiersPerPool: 1,
    pools: [pool('pA', 'Poule A'), pool('pB', 'Poule B')],
    teams: [team('a1', 'pA'), team('a2', 'pA'), team('b1', 'pB'), team('b2', 'pB')],
    ...overrides,
  });
}

/** Completes every challenge of the given round with a plain team1-wins-2-0 result. */
function completeRound(t: Tournament, roundNumber: number): void {
  for (const c of t.challenges) {
    if (c.round !== roundNumber) continue;
    c.status = 'completed';
    c.result = {
      playedAt: '2026-01-01',
      team1Td: 2,
      team2Td: 0,
      team1Cas: 0,
      team2Cas: 0,
      team1Agg: 0,
      team2Agg: 0,
      customStats: {},
      concededByTeamId: null,
      team1Points: 5,
      team2Points: 0,
      submittedByTeamId: c.team1Id,
      submittedAt: '2026-01-01T00:00:00.000Z',
      confirmedByTeamId: c.team2Id,
      completedAt: '2026-01-01T00:00:00.000Z',
    };
  }
}

describe('generateNextRound — mode dispatch', () => {
  test('ladder mode still refuses round generation entirely', () => {
    assert.throws(() => generateNextRound(baseTournament({ mode: 'ladder' })));
  });

  test('pools_knockout dispatches to pool-phase pairing (scoped per pool)', () => {
    const t = poolsKnockoutTournament();
    generateNextRound(t);
    assert.equal(t.rounds.length, 1);
    const pairs = t.challenges.filter((c) => c.round === 1);
    assert.equal(pairs.length, 2);
    const poolOfTeam = (id: string) => t.teams.find((tm) => tm.id === id)!.poolId;
    for (const c of pairs) {
      assert.equal(poolOfTeam(c.team1Id), poolOfTeam(c.team2Id));
    }
  });

  test('pools_knockout refuses to generate the first knockout round before the final phase is launched', () => {
    const t = poolsKnockoutTournament();
    generateNextRound(t); // round 1 (pool phase)
    completeRound(t, 1);
    // Round 2 would be the first knockout round, but launchKnockoutPhase was never called.
    assert.throws(() => generateNextRound(t), /knockout_not_launched|pas encore été lancée/i);
  });

  test('once the final phase is launched, generateNextRound dispatches subsequent knockout rounds too', () => {
    const t = poolsKnockoutTournament();
    generateNextRound(t); // round 1 (pool phase)
    completeRound(t, 1);
    launchKnockoutPhase(t); // creates round 2 (the final, here — only 2 qualifiers)
    assert.equal(t.rounds.length, 2);
    // The bracket is already down to its final match; generating "round 3" should refuse — nothing left to pair.
    completeRound(t, 2);
    assert.throws(() => generateNextRound(t), /knockout_complete|déjà terminé/i);
  });
});

function challenge(id: string, team1Id: string, team2Id: string, round: number): Challenge {
  return {
    id,
    team1Id,
    team2Id,
    status: 'accepted',
    round,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    result: null,
  };
}

describe('swapRoundMatches', () => {
  // Pilaf vs Theag, Thot vs Harti — picking Theag and Harti should produce Theag vs Harti,
  // with the two leftover coaches (Pilaf and Thot) automatically paired together.
  function roundOfFour(): Tournament {
    return baseTournament({
      mode: 'swiss',
      teams: [team('pilaf', null), team('theag', null), team('thot', null), team('harti', null)],
      rounds: [{ number: 1, status: 'draft' }],
      challenges: [challenge('m1', 'pilaf', 'theag', 1), challenge('m2', 'thot', 'harti', 1)],
    });
  }

  test('pits the two chosen coaches against each other, pairing the leftovers together', () => {
    const t = roundOfFour();
    swapRoundMatches(t, 1, 'theag', 'harti');

    const m1 = t.challenges.find((c) => c.id === 'm1')!;
    const m2 = t.challenges.find((c) => c.id === 'm2')!;
    assert.deepEqual(new Set([m1.team1Id, m1.team2Id]), new Set(['theag', 'harti']));
    assert.deepEqual(new Set([m2.team1Id, m2.team2Id]), new Set(['pilaf', 'thot']));
  });

  test('works regardless of which side (team1/team2) each coach is currently on', () => {
    const t = roundOfFour();
    // 'pilaf' is a team1Id, 'harti' is a team2Id — opposite sides of their matches.
    swapRoundMatches(t, 1, 'pilaf', 'harti');

    const m1 = t.challenges.find((c) => c.id === 'm1')!;
    const m2 = t.challenges.find((c) => c.id === 'm2')!;
    assert.deepEqual(new Set([m1.team1Id, m1.team2Id]), new Set(['pilaf', 'harti']));
    assert.deepEqual(new Set([m2.team1Id, m2.team2Id]), new Set(['thot', 'theag']));
  });

  test('rejects pairing a coach against themselves', () => {
    const t = roundOfFour();
    assert.throws(() => swapRoundMatches(t, 1, 'theag', 'theag'), /themselves/);
  });

  test('rejects two coaches already playing each other', () => {
    const t = roundOfFour();
    assert.throws(() => swapRoundMatches(t, 1, 'pilaf', 'theag'), /already playing/);
  });

  test('rejects editing a launched round', () => {
    const t = roundOfFour();
    t.rounds[0].status = 'launched';
    assert.throws(() => swapRoundMatches(t, 1, 'theag', 'harti'), /round_not_draft|draft round/);
  });

  test('team format: rejects a swap that would pit two players from the same squad against each other', () => {
    const t = baseTournament({
      mode: 'swiss',
      format: 'team',
      squads: [
        { id: 'sA', name: 'Squad A', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'sB', name: 'Squad B', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      teams: [
        { ...team('a1', null), squadId: 'sA' },
        { ...team('a2', null), squadId: 'sA' },
        { ...team('b1', null), squadId: 'sB' },
        { ...team('b2', null), squadId: 'sB' },
      ],
      rounds: [{ number: 1, status: 'draft' }],
      challenges: [challenge('m1', 'a1', 'b1', 1), challenge('m2', 'a2', 'b2', 1)],
    });

    // Pairing a1 (squad A) against a2 (squad A) would leave b1 vs b2 — both same-squad matches.
    assert.throws(() => swapRoundMatches(t, 1, 'a1', 'a2'), /same squad/);
  });

  test('team format: allows a swap that keeps both squads facing each other', () => {
    const t = baseTournament({
      mode: 'swiss',
      format: 'team',
      squads: [
        { id: 'sA', name: 'Squad A', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'sB', name: 'Squad B', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      teams: [
        { ...team('a1', null), squadId: 'sA' },
        { ...team('a2', null), squadId: 'sA' },
        { ...team('b1', null), squadId: 'sB' },
        { ...team('b2', null), squadId: 'sB' },
      ],
      rounds: [{ number: 1, status: 'draft' }],
      challenges: [challenge('m1', 'a1', 'b1', 1), challenge('m2', 'a2', 'b2', 1)],
    });

    // Pit a1 against b2 directly (both cross-squad) — leaves a2 vs b1, also cross-squad.
    swapRoundMatches(t, 1, 'a1', 'b2');
    const m1 = t.challenges.find((c) => c.id === 'm1')!;
    const m2 = t.challenges.find((c) => c.id === 'm2')!;
    assert.deepEqual(new Set([m1.team1Id, m1.team2Id]), new Set(['a1', 'b2']));
    assert.deepEqual(new Set([m2.team1Id, m2.team2Id]), new Set(['a2', 'b1']));
  });
});
