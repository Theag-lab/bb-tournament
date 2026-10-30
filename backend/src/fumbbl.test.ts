import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INDIVIDUAL_SCORING, type Challenge, type Tournament } from '@bb-tournament/shared';
import { applyFinishedMatch, dropStaleLinks, gamesNoLongerLive, linkLiveGames, type FumbblLiveGame, type FumbblMatch } from './fumbbl';

const TAG = '[LuteceWC2027]';
const NOW = '2026-10-28T10:00:00.000Z';

function tournament(overrides: Partial<Tournament> = {}, challengeOverrides: Partial<Challenge> = {}): Tournament {
  return {
    fumbbl: { enabled: true, tag: TAG },
    individualScoring: DEFAULT_INDIVIDUAL_SCORING,
    customStatCategories: [],
    rounds: [{ number: 1, status: 'launched' }],
    teams: [
      { id: 'tTheag', coachName: 'Theag' },
      { id: 'tRedo', coachName: 'ReDoLiv' },
    ],
    challenges: [
      {
        id: 'c1',
        team1Id: 'tTheag',
        team2Id: 'tRedo',
        status: 'accepted',
        round: 1,
        createdAt: NOW,
        updatedAt: NOW,
        result: null,
        ...challengeOverrides,
      },
    ],
    ...overrides,
  } as unknown as Tournament;
}

// FUMBBL lists ReDoLiv as home: sides are reversed compared to the tournament's team1/team2.
const liveGame: FumbblLiveGame = {
  id: 1957579,
  teams: [
    { id: 222, name: `${TAG} HumanRedo1`, coach: 'redoliv' },
    { id: 111, name: `${TAG} Theag`, coach: 'Theag' },
  ],
};

const finishedMatch: FumbblMatch = {
  id: 4745428,
  replayId: 1957579,
  date: '2026-10-27',
  team1: { id: 111, name: `${TAG} Theag`, score: 0, casualties: { bh: 0, si: 0, rip: 0 }, coach: { name: 'Theag' } },
  team2: { id: 222, name: `${TAG} HumanRedo1`, score: 1, casualties: { bh: 2, si: 1, rip: 0 }, coach: { name: 'ReDoLiv' } },
};

describe('linkLiveGames', () => {
  test('links a tagged live game to the scheduled match, coach names case-insensitive, sides mapped', () => {
    const t = tournament();
    assert.deepEqual(linkLiveGames(t, [liveGame], NOW), ['c1']);
    assert.deepEqual(t.challenges[0].fumbbl, {
      liveGameId: 1957579,
      team1FumbblTeamId: 111,
      team2FumbblTeamId: 222,
      state: 'live',
      matchId: null,
      detectedAt: NOW,
      finishedAt: null,
    });
  });

  test('links a game only once', () => {
    const t = tournament();
    linkLiveGames(t, [liveGame], NOW);
    assert.deepEqual(linkLiveGames(t, [liveGame], NOW), []);
  });

  test('links a game where only one team carries the tag', () => {
    const halfTagged = { ...liveGame, teams: [liveGame.teams[0], { ...liveGame.teams[1], name: 'Theag' }] };
    assert.equal(linkLiveGames(tournament(), [halfTagged], NOW).length, 1);
  });

  test('ignores a game where neither team carries the tag', () => {
    const untagged = { ...liveGame, teams: liveGame.teams.map((team, i) => ({ ...team, name: `Team ${i}` })) };
    assert.deepEqual(linkLiveGames(tournament(), [untagged], NOW), []);
  });

  test('ignores tracking turned off, a draft round, or a match that already has a result', () => {
    assert.deepEqual(linkLiveGames(tournament({ fumbbl: { enabled: false, tag: TAG } }), [liveGame], NOW), []);
    assert.deepEqual(linkLiveGames(tournament({ rounds: [{ number: 1, status: 'draft' }] }), [liveGame], NOW), []);
    assert.deepEqual(linkLiveGames(tournament({}, { status: 'awaiting_confirmation' }), [liveGame], NOW), []);
  });
});

describe('applyFinishedMatch', () => {
  test('enters the result on the right sides, sorties = bh + si + rip, final', () => {
    const t = tournament();
    linkLiveGames(t, [liveGame], NOW);
    const [challenge] = gamesNoLongerLive(t, new Set());
    const result = applyFinishedMatch(t, challenge, finishedMatch, NOW)!;
    assert.equal(challenge.status, 'completed');
    assert.deepEqual([result.team1Td, result.team2Td, result.team1Cas, result.team2Cas], [0, 1, 0, 3]);
    assert.equal(result.playedAt, '2026-10-27');
    assert.equal(result.source, 'fumbbl');
    assert.ok(result.team2Points > result.team1Points);
    assert.deepEqual([challenge.fumbbl!.state, challenge.fumbbl!.matchId], ['finished', 4745428]);
  });

  test('never overwrites a result entered meanwhile, but still completes the FUMBBL link', () => {
    const t = tournament();
    linkLiveGames(t, [liveGame], NOW);
    const challenge = t.challenges[0];
    challenge.status = 'awaiting_confirmation';
    assert.equal(applyFinishedMatch(t, challenge, finishedMatch, NOW), null);
    assert.equal(challenge.result, null);
    assert.equal(challenge.fumbbl!.matchId, 4745428);
  });
});

describe('dropStaleLinks', () => {
  test('unlinks a game gone from the live list and unresolved for over a day, not a recent one', () => {
    const t = tournament();
    linkLiveGames(t, [liveGame], NOW);
    assert.equal(dropStaleLinks(t, new Set(), Date.parse(NOW) + 60 * 60 * 1000), 0);
    assert.equal(dropStaleLinks(t, new Set(), Date.parse(NOW) + 25 * 60 * 60 * 1000), 1);
    assert.equal(t.challenges[0].fumbbl, undefined);
  });
});
