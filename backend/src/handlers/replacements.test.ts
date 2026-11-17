import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_MATCH_SHEET_CONFIG,
  DEFAULT_ROUND_TIMER,
  DEFAULT_SQUAD_SCORING,
  activeSquadMembers,
  computeSquadStandings,
  replacedTeamIds,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';
import { generateNextRound, launchRound, pairingStandings, seatHolders } from '../rounds';
import { toPublicTournament } from '../sanitize';
import { applyReplacement, revertReplacement } from './replacements';
import { AppError } from '../errors';

function member(id: string, squadId: string): Team {
  return {
    id,
    password: 'password123',
    name: id,
    coachName: id,
    race: 'Human',
    nafNumber: null,
    squadId,
    poolId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    rosterImage: null,
    rosterStatus: 'created',
  };
}

/** Two squads of 2 (a1, a2 / b1, b2), swiss over 3 rounds, nothing generated yet. */
function tournament(): Tournament {
  return {
    id: 't1',
    name: 'Coupe',
    description: '',
    organizerCoachName: 'Orga',
    requireRosterValidation: false,
    requireResultConfirmation: true,
    showTeamNames: true,
    mode: 'swiss',
    roundCount: 3,
    rounds: [],
    format: 'team',
    squadSize: 2,
    squadScoring: DEFAULT_SQUAD_SCORING,
    squads: [
      { id: 'A', name: 'A', createdAt: '2026-01-01' },
      { id: 'B', name: 'B', createdAt: '2026-01-01' },
    ],
    poolSize: null,
    poolRoundCount: null,
    qualifiersPerPool: null,
    pools: [],
    knockoutSeeds: null,
    individualScoring: DEFAULT_INDIVIDUAL_SCORING,
    matchSheetConfig: DEFAULT_MATCH_SHEET_CONFIG,
    customStatCategories: [],
    roundTimer: DEFAULT_ROUND_TIMER,
    adminToken: 'admin',
    createdAt: '2026-01-01T00:00:00.000Z',
    teams: [member('a1', 'A'), member('a2', 'A'), member('b1', 'B'), member('b2', 'B')],
    challenges: [],
  };
}

/** Plays every match of the round, team1 winning 1-0. */
function playRound(t: Tournament, round: number): void {
  for (const c of t.challenges.filter((ch) => ch.round === round)) {
    c.status = 'completed';
    c.result = {
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
      submittedByTeamId: c.team1Id,
      submittedAt: '2026-01-01T00:00:00.000Z',
      confirmedByTeamId: c.team2Id,
      completedAt: '2026-01-01T00:00:00.000Z',
    };
  }
}

const now = '2026-01-02T00:00:00.000Z';
const coachesOf = (t: Tournament, round: number) =>
  new Set(t.challenges.filter((c) => c.round === round).flatMap((c) => [c.team1Id, c.team2Id]));

describe('replacements', () => {
  test("a substitute plays from the next round on, in the replaced coach's squad", () => {
    const t = tournament();
    generateNextRound(t);
    launchRound(t, 1);
    playRound(t, 1);
    const r = applyReplacement(t, { outTeamId: 'a1', substitute: { coachName: 'Sub', race: 'Orc', nafNumber: '123' } }, now);
    assert.equal(r.round, 2);
    const sub = t.teams.find((tm) => tm.id === r.inTeamId)!;
    assert.deepEqual([sub.squadId, sub.race, sub.nafNumber, sub.substitute], ['A', 'Orc', '123', true]);
    generateNextRound(t);
    assert.ok(coachesOf(t, 2).has(sub.id));
    assert.ok(!coachesOf(t, 2).has('a1'));
  });

  test("in a draft round, the substitute takes the replaced coach's match", () => {
    const t = tournament();
    generateNextRound(t);
    const match = t.challenges.find((c) => c.team1Id === 'a1' || c.team2Id === 'a1')!;
    const r = applyReplacement(t, { outTeamId: 'a1', substitute: { coachName: 'Sub', race: 'Orc' } }, now);
    assert.equal(r.round, 1);
    assert.ok(match.team1Id === r.inTeamId || match.team2Id === r.inTeamId);
    revertReplacement(t, r.id, now);
    assert.ok(match.team1Id === 'a1' || match.team2Id === 'a1');
    assert.equal(t.teams.length, 4, 'the unused substitute is removed');
    assert.deepEqual(t.replacements, []);
  });

  test('the original can come back later; both leave the individual standings, their matches still count for the squad', () => {
    const t = tournament();
    generateNextRound(t);
    launchRound(t, 1);
    playRound(t, 1);
    const out = applyReplacement(t, { outTeamId: 'a1', substitute: { coachName: 'Sub', race: 'Orc' } }, now);
    generateNextRound(t);
    launchRound(t, 2);
    playRound(t, 2);
    const back = applyReplacement(t, { outTeamId: out.inTeamId, inTeamId: 'a1' }, '2026-01-03T00:00:00.000Z');
    assert.equal(back.round, 3);
    assert.deepEqual(activeSquadMembers(t.teams, t.replacements, 'A', 3), new Set(['a2', 'a1']));
    assert.deepEqual(activeSquadMembers(t.teams, t.replacements, 'A', 2), new Set(['a2', out.inTeamId]));

    const pub = toPublicTournament(t);
    const ranked = new Set(pub.standings.map((s) => s.teamId));
    assert.ok(!ranked.has('a1') && !ranked.has(out.inTeamId));
    assert.ok(ranked.has('a2'));
    assert.deepEqual(replacedTeamIds(t.replacements), new Set(['a1', out.inTeamId]));
    const squadA = computeSquadStandings(t.squads, t.teams, t.challenges, DEFAULT_SQUAD_SCORING).find((s) => s.squadId === 'A')!;
    assert.equal(squadA.gamesPlayed, 4);
  });

  test('refuses: a coach not playing that round, a substitute named like a registered coach, a launched round undo', () => {
    const t = tournament();
    generateNextRound(t);
    const r = applyReplacement(t, { outTeamId: 'a1', substitute: { coachName: 'Sub', race: 'Orc' } }, now);
    assert.throws(() => applyReplacement(t, { outTeamId: 'a1', substitute: { coachName: 'Other', race: 'Orc' } }, now), AppError);
    assert.throws(() => applyReplacement(t, { outTeamId: 'a2', substitute: { coachName: 'b1', race: 'Orc' } }, now), AppError);
    assert.throws(() => applyReplacement(t, { outTeamId: 'a2', inTeamId: 'b1' }, now), AppError);
    launchRound(t, 1);
    assert.throws(() => revertReplacement(t, r.id, now), AppError);
  });
});

describe('replacements — individual format', () => {
  /** 6 coaches p1..p6, swiss over 3 rounds. */
  function individual(): Tournament {
    return {
      ...tournament(),
      format: 'individual',
      squadSize: null,
      squadScoring: null,
      squads: [],
      teams: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((id) => ({ ...member(id, ''), squadId: null })),
    };
  }

  test('the substitute is paired on the seat\u2019s combined results, avoiding the replaced coach\u2019s opponents', () => {
    const t = individual();
    generateNextRound(t);
    launchRound(t, 1);
    playRound(t, 1); // team1 of each match wins
    const winner = t.challenges[0].team1Id;
    const beaten = t.challenges[0].team2Id;
    const r = applyReplacement(t, { outTeamId: winner, substitute: { coachName: 'Sub', race: 'Orc' } }, now);
    assert.equal(seatHolders(t, 2).get(winner), r.inTeamId);
    // The seat carries the replaced coach's win: the substitute ranks among the 3 round-1 winners.
    assert.ok(pairingStandings(t, 2).indexOf(r.inTeamId) < 3);

    generateNextRound(t);
    const round2 = t.challenges.filter((c) => c.round === 2);
    const playing = round2.flatMap((c) => [c.team1Id, c.team2Id]);
    assert.equal(playing.length, 6);
    assert.ok(playing.includes(r.inTeamId) && !playing.includes(winner));
    const subMatch = round2.find((c) => c.team1Id === r.inTeamId || c.team2Id === r.inTeamId)!;
    const subOpponent = subMatch.team1Id === r.inTeamId ? subMatch.team2Id : subMatch.team1Id;
    assert.notEqual(subOpponent, beaten, 'no rematch for the seat');

    const ranked = new Set(toPublicTournament(t).standings.map((s) => s.teamId));
    assert.ok(!ranked.has(winner) && !ranked.has(r.inTeamId));
  });

  test('any coach not playing that round can come back, without a squad', () => {
    const t = individual();
    generateNextRound(t);
    launchRound(t, 1);
    playRound(t, 1);
    const out = applyReplacement(t, { outTeamId: 'p1', substitute: { coachName: 'Sub', race: 'Orc' } }, now);
    generateNextRound(t);
    launchRound(t, 2);
    playRound(t, 2);
    applyReplacement(t, { outTeamId: out.inTeamId, inTeamId: 'p1' }, '2026-01-03T00:00:00.000Z');
    generateNextRound(t);
    const round3 = new Set(t.challenges.filter((c) => c.round === 3).flatMap((c) => [c.team1Id, c.team2Id]));
    assert.ok(round3.has('p1') && !round3.has(out.inTeamId));
    assert.equal(round3.size, 6);
  });
});
