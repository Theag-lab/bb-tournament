import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_ROUND_TIMER,
  type Pool,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';
import { generateNextRound } from './rounds';
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
