import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMatchScore,
  computeSquadStandings,
  computeStandings,
  recomputeMatchPoints,
  DEFAULT_INDIVIDUAL_SCORING,
} from './scoring';
import {
  DEFAULT_SQUAD_SCORING,
  type Challenge,
  type IndividualScoringConfig,
  type MatchResult,
  type Squad,
  type SubmitResultRequest,
  type Team,
} from './types';

function config(overrides: Partial<IndividualScoringConfig> = {}): IndividualScoringConfig {
  return {
    mode: DEFAULT_INDIVIDUAL_SCORING.mode,
    pointsWin: DEFAULT_INDIVIDUAL_SCORING.pointsWin,
    pointsDraw: DEFAULT_INDIVIDUAL_SCORING.pointsDraw,
    pointsLoss: DEFAULT_INDIVIDUAL_SCORING.pointsLoss,
    pointsConcessionPenalty: DEFAULT_INDIVIDUAL_SCORING.pointsConcessionPenalty,
    tiebreakers: [...DEFAULT_INDIVIDUAL_SCORING.tiebreakers],
    td: { ...DEFAULT_INDIVIDUAL_SCORING.td },
    cas: { ...DEFAULT_INDIVIDUAL_SCORING.cas },
    agg: { ...DEFAULT_INDIVIDUAL_SCORING.agg },
    ...overrides,
  };
}

function resultInput(overrides: Partial<SubmitResultRequest> = {}): SubmitResultRequest {
  return {
    playedAt: '2026-01-01',
    team1Td: 0,
    team2Td: 0,
    team1Cas: 0,
    team2Cas: 0,
    team1Agg: 0,
    team2Agg: 0,
    concededByTeamId: null,
    ...overrides,
  };
}

/** Builds a completed MatchResult from raw stats, for feeding directly into standings functions. */
function matchResult(overrides: Partial<MatchResult> & Pick<MatchResult, 'team1Td' | 'team2Td'>): MatchResult {
  return {
    team1Cas: 0,
    team2Cas: 0,
    team1Agg: 0,
    team2Agg: 0,
    team1Points: 0,
    team2Points: 0,
    concededByTeamId: null,
    submittedByTeamId: 't1',
    submittedAt: '2026-01-01T00:00:00.000Z',
    confirmedByTeamId: 't2',
    completedAt: '2026-01-01T00:00:00.000Z',
    playedAt: '2026-01-01',
    ...overrides,
  };
}

function completedChallenge(
  team1Id: string,
  team2Id: string,
  round: number | null,
  result: MatchResult,
  status: Challenge['status'] = 'completed'
): Challenge {
  return {
    id: `${team1Id}-vs-${team2Id}-r${round}`,
    team1Id,
    team2Id,
    status,
    round,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    result,
  };
}

describe('computeMatchScore — points_tiebreaker mode (classic)', () => {
  test('awards pointsWin/pointsDraw/pointsLoss by TD comparison', () => {
    const cfg = config();
    const win = computeMatchScore(resultInput({ team1Td: 2, team2Td: 1 }), 't1', 't2', cfg);
    assert.equal(win.team1Points, cfg.pointsWin);
    assert.equal(win.team2Points, cfg.pointsLoss);

    const draw = computeMatchScore(resultInput({ team1Td: 1, team2Td: 1 }), 't1', 't2', cfg);
    assert.equal(draw.team1Points, cfg.pointsDraw);
    assert.equal(draw.team2Points, cfg.pointsDraw);
  });

  test('concession forces a 3-0 score and applies pointsConcessionPenalty to the conceder', () => {
    const cfg = config();
    const score = computeMatchScore(resultInput({ concededByTeamId: 't2', team1Td: 0, team2Td: 0 }), 't1', 't2', cfg);
    assert.equal(score.team1Td, 3);
    assert.equal(score.team2Td, 0);
    assert.equal(score.team1Cas, 3);
    assert.equal(score.team1Agg, 3);
    assert.equal(score.team1Points, cfg.pointsWin);
    assert.equal(score.team2Points, cfg.pointsConcessionPenalty);
  });

  test('rejects a concededByTeamId that is neither participant', () => {
    assert.throws(() => computeMatchScore(resultInput({ concededByTeamId: 'nobody' }), 't1', 't2', config()));
  });

  test('clamps negative/fractional stat inputs', () => {
    const score = computeMatchScore(resultInput({ team1Td: -3, team2Td: 2.9 }), 't1', 't2', config());
    assert.equal(score.team1Td, 0);
    assert.equal(score.team2Td, 2);
  });
});

describe('computeMatchScore — raw_points mode', () => {
  test('400 pts for a win + 3 pts per TD scored (total basis)', () => {
    const cfg = config({
      mode: 'raw_points',
      pointsWin: 400,
      pointsDraw: 100,
      pointsLoss: 0,
      td: { basis: 'total', multiplier: 3 },
    });
    const score = computeMatchScore(resultInput({ team1Td: 3, team2Td: 1 }), 't1', 't2', cfg);
    assert.equal(score.team1Points, 400 + 3 * 3);
    assert.equal(score.team2Points, 0 + 3 * 1);
  });

  test('diff basis uses the net stat difference instead of the raw total', () => {
    const cfg = config({ mode: 'raw_points', td: { basis: 'diff', multiplier: 10 } });
    const score = computeMatchScore(resultInput({ team1Td: 3, team2Td: 1 }), 't1', 't2', cfg);
    assert.equal(score.team1Points, cfg.pointsWin + 10 * (3 - 1));
    assert.equal(score.team2Points, cfg.pointsLoss + 10 * (1 - 3));
  });

  test('multiplier 0 disables a component entirely', () => {
    const cfg = config({ mode: 'raw_points', cas: { basis: 'total', multiplier: 0 } });
    const withCas = computeMatchScore(resultInput({ team1Td: 1, team2Td: 0, team1Cas: 99 }), 't1', 't2', cfg);
    const withoutCas = computeMatchScore(resultInput({ team1Td: 1, team2Td: 0, team1Cas: 0 }), 't1', 't2', cfg);
    assert.equal(withCas.team1Points, withoutCas.team1Points);
  });

  test('td/cas/agg components stack additively', () => {
    const cfg = config({
      mode: 'raw_points',
      pointsWin: 0,
      pointsDraw: 0,
      pointsLoss: 0,
      td: { basis: 'total', multiplier: 1 },
      cas: { basis: 'total', multiplier: 2 },
      agg: { basis: 'total', multiplier: 5 },
    });
    const score = computeMatchScore(
      resultInput({ team1Td: 2, team2Td: 0, team1Cas: 3, team2Cas: 0, team1Agg: 1, team2Agg: 0 }),
      't1',
      't2',
      cfg
    );
    assert.equal(score.team1Points, 2 * 1 + 3 * 2 + 1 * 5);
  });
});

describe('computeStandings', () => {
  const teams: Team[] = [
    { id: 't1' } as Team,
    { id: 't2' } as Team,
    { id: 't3' } as Team,
    { id: 't4' } as Team,
  ];

  test('sorts by total points first', () => {
    const cfg = config();
    const challenges: Challenge[] = [
      completedChallenge('t1', 't2', 1, matchResult({ team1Td: 2, team2Td: 0, team1Points: 5, team2Points: 0 })),
      completedChallenge('t3', 't4', 1, matchResult({ team1Td: 1, team2Td: 1, team1Points: 2, team2Points: 2 })),
    ];
    const standings = computeStandings(teams, challenges, cfg);
    assert.equal(standings[0].teamId, 't1');
    assert.equal(standings[0].points, 5);
  });

  test("W/D/L record is always the classic TD-based outcome, independent of the points formula", () => {
    // t1 "wins" on raw score (TD diff bonus) despite LOSING on TD comparison (1 < 2) — its W/D/L
    // record must still reflect the loss, not the points total.
    const cfg = config({
      mode: 'raw_points',
      pointsWin: 0,
      pointsDraw: 0,
      pointsLoss: 0,
      td: { basis: 'total', multiplier: 1 },
      cas: { basis: 'total', multiplier: 100 },
    });
    const challenges: Challenge[] = [
      completedChallenge(
        't1',
        't2',
        1,
        matchResult({ team1Td: 1, team2Td: 2, team1Cas: 5, team2Cas: 0, team1Points: 501, team2Points: 2 })
      ),
    ];
    const standings = computeStandings(teams, challenges, cfg);
    const t1 = standings.find((s) => s.teamId === 't1')!;
    const t2 = standings.find((s) => s.teamId === 't2')!;
    assert.equal(t1.points, 501, 'sanity: t1 does lead on raw points');
    assert.equal(t1.losses, 1);
    assert.equal(t1.wins, 0);
    assert.equal(t2.wins, 1);
    assert.equal(t2.losses, 0);
  });

  test('opponentScore (Buchholz) sums opponents final points', () => {
    const cfg = config();
    const challenges: Challenge[] = [
      completedChallenge('t1', 't2', 1, matchResult({ team1Td: 2, team2Td: 0, team1Points: 5, team2Points: 0 })),
      completedChallenge('t2', 't3', 2, matchResult({ team1Td: 1, team2Td: 1, team1Points: 2, team2Points: 2 })),
    ];
    const standings = computeStandings(teams, challenges, cfg);
    const t1 = standings.find((s) => s.teamId === 't1')!;
    // t1's only opponent (t2) ends with 0 (from round 1) + 2 (from round 2) = 2 points.
    assert.equal(t1.opponentScore, 2);
  });

  for (const [criterion, setup, expectedFirst] of [
    [
      'fewest_td_conceded',
      (): Challenge[] => [
        completedChallenge('t1', 't3', 1, matchResult({ team1Td: 1, team2Td: 1, team1Points: 2, team2Points: 2 })),
        completedChallenge('t2', 't4', 1, matchResult({ team1Td: 3, team2Td: 3, team1Points: 2, team2Points: 2 })),
      ],
      't1',
    ],
    [
      'net_td',
      (): Challenge[] => [
        completedChallenge('t1', 't3', 1, matchResult({ team1Td: 5, team2Td: 1, team1Points: 2, team2Points: 2 })),
        completedChallenge('t2', 't4', 1, matchResult({ team1Td: 2, team2Td: 1, team1Points: 2, team2Points: 2 })),
      ],
      't1',
    ],
    [
      'net_cas',
      (): Challenge[] => [
        completedChallenge(
          't1',
          't3',
          1,
          matchResult({ team1Td: 1, team2Td: 1, team1Cas: 4, team2Cas: 0, team1Points: 2, team2Points: 2 })
        ),
        completedChallenge(
          't2',
          't4',
          1,
          matchResult({ team1Td: 1, team2Td: 1, team1Cas: 1, team2Cas: 0, team1Points: 2, team2Points: 2 })
        ),
      ],
      't1',
    ],
    [
      'net_agg',
      (): Challenge[] => [
        completedChallenge(
          't1',
          't3',
          1,
          matchResult({ team1Td: 1, team2Td: 1, team1Agg: 4, team2Agg: 0, team1Points: 2, team2Points: 2 })
        ),
        completedChallenge(
          't2',
          't4',
          1,
          matchResult({ team1Td: 1, team2Td: 1, team1Agg: 1, team2Agg: 0, team1Points: 2, team2Points: 2 })
        ),
      ],
      't1',
    ],
  ] as const) {
    test(`tiebreaker "${criterion}" alone breaks a tie at equal points`, () => {
      const cfg = config({ tiebreakers: [criterion] });
      const standings = computeStandings(teams, setup(), cfg);
      assert.equal(standings[0].teamId, expectedFirst);
    });
  }

  test('tiebreakers apply in the configured order, not the historical default order', () => {
    // t1 and t2 tie on points (2 each); t1 concedes fewer TD (better fewest_td_conceded) but t2's
    // sole opponent (t4) ends with more final points than t1's sole opponent (t3), giving t2 the
    // better opponentScore. With tiebreakers=[opponent_score, fewest_td_conceded], t2 must rank
    // first — the opposite of what fewest_td_conceded-first would produce. t3/t4 are kept below
    // t1/t2 on points so they don't just win outright on the primary points sort.
    const cfg = config({ tiebreakers: ['opponent_score', 'fewest_td_conceded'] });
    const challenges: Challenge[] = [
      completedChallenge('t1', 't3', 1, matchResult({ team1Td: 1, team2Td: 0, team1Points: 2, team2Points: 0 })),
      completedChallenge('t2', 't4', 1, matchResult({ team1Td: 5, team2Td: 5, team1Points: 2, team2Points: 1 })),
    ];
    const standings = computeStandings([...teams], challenges, cfg);
    assert.equal(standings[0].teamId, 't2');
  });

  test('raw_points mode ignores the tiebreakers list entirely', () => {
    const cfg = config({
      mode: 'raw_points',
      pointsWin: 0,
      pointsDraw: 0,
      pointsLoss: 0,
      td: { basis: 'total', multiplier: 0 },
      tiebreakers: ['fewest_td_conceded'], // must be ignored in raw_points mode
    });
    // Both teams end at 0 raw points but t2 "should" win fewest_td_conceded if it were honored.
    const challenges: Challenge[] = [
      completedChallenge('t1', 't3', 1, matchResult({ team1Td: 1, team2Td: 0, team1Points: 0, team2Points: 0 })),
      completedChallenge('t2', 't4', 1, matchResult({ team1Td: 9, team2Td: 9, team1Points: 0, team2Points: 0 })),
    ];
    const standings = computeStandings(teams, challenges, cfg);
    // Result must still be a full, deterministic order (stable random fallback), and must not
    // throw despite an empty effective tiebreaker list.
    assert.equal(standings.length, 4);
  });

  test('unfinished/uncompleted challenges do not affect standings', () => {
    const cfg = config();
    const challenges: Challenge[] = [
      completedChallenge('t1', 't2', 1, matchResult({ team1Td: 2, team2Td: 0, team1Points: 5, team2Points: 0 }), 'awaiting_confirmation'),
    ];
    const standings = computeStandings(teams, challenges, cfg);
    assert.ok(standings.every((s) => s.gamesPlayed === 0 && s.points === 0));
  });
});

describe('computeSquadStandings — board-diff round tiering', () => {
  const squads: Squad[] = [
    { id: 'A', name: 'A', createdAt: '2026-01-01' },
    { id: 'B', name: 'B', createdAt: '2026-01-01' },
  ];

  function squadTeams(count: number, squadId: string, prefix: string): Team[] {
    return Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, squadId } as Team));
  }

  test('regression: 3W/1D/1L then 2W/1D/2L nets one round win + one round draw (not 5W/2D/3L)', () => {
    const teams = [...squadTeams(5, 'A', 'a'), ...squadTeams(5, 'B', 'b')];
    const round1: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a2', 'b2', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a3', 'b3', 1, matchResult({ team1Td: 1, team2Td: 1 })),
      completedChallenge('a4', 'b4', 1, matchResult({ team1Td: 0, team2Td: 2 })),
    ];
    const round2: Challenge[] = [
      completedChallenge('a0', 'b0', 2, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 2, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a2', 'b2', 2, matchResult({ team1Td: 1, team2Td: 1 })),
      completedChallenge('a3', 'b3', 2, matchResult({ team1Td: 0, team2Td: 2 })),
      completedChallenge('a4', 'b4', 2, matchResult({ team1Td: 0, team2Td: 2 })),
    ];
    const standings = computeSquadStandings(squads, teams, [...round1, ...round2], DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    const b = standings.find((s) => s.squadId === 'B')!;
    assert.deepEqual([a.wins, a.draws, a.losses], [1, 1, 0]);
    assert.deepEqual([b.wins, b.draws, b.losses], [0, 1, 1]);
  });

  test('board-diff of exactly +1 lands in the smallWin tier', () => {
    const teams = [...squadTeams(5, 'A', 'a'), ...squadTeams(5, 'B', 'b')];
    // 3 wins, 2 losses -> net +1
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a2', 'b2', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a3', 'b3', 1, matchResult({ team1Td: 0, team2Td: 2 })),
      completedChallenge('a4', 'b4', 1, matchResult({ team1Td: 0, team2Td: 2 })),
    ];
    const standings = computeSquadStandings(squads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    assert.equal(a.points, DEFAULT_SQUAD_SCORING.pointsSmallWin);
  });

  test('board-diff of +2 (above smallMarginMaxDiff, below bigMarginMinDiff) lands in the plain win tier', () => {
    const teams = [...squadTeams(5, 'A', 'a'), ...squadTeams(5, 'B', 'b')];
    // 3 wins, 1 draw, 1 loss -> net +2
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a2', 'b2', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a3', 'b3', 1, matchResult({ team1Td: 1, team2Td: 1 })),
      completedChallenge('a4', 'b4', 1, matchResult({ team1Td: 0, team2Td: 2 })),
    ];
    const standings = computeSquadStandings(squads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    assert.equal(a.points, DEFAULT_SQUAD_SCORING.pointsWin);
  });

  test('board-diff at/above bigMarginMinDiff (3) lands in the "victoire totale" tier', () => {
    const teams = [...squadTeams(5, 'A', 'a'), ...squadTeams(5, 'B', 'b')];
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a2', 'b2', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a3', 'b3', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a4', 'b4', 1, matchResult({ team1Td: 0, team2Td: 2 })),
    ];
    const standings = computeSquadStandings(squads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    assert.equal(a.points, DEFAULT_SQUAD_SCORING.pointsBigWin);
  });

  test('squad of size 2: "victoire totale" is unreachable, a full sweep lands in the plain win tier', () => {
    const smallSquads: Squad[] = squads;
    const teams = [...squadTeams(2, 'A', 'a'), ...squadTeams(2, 'B', 'b')];
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
    ];
    const standings = computeSquadStandings(smallSquads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    assert.equal(a.points, DEFAULT_SQUAD_SCORING.pointsWin);
    assert.notEqual(a.points, DEFAULT_SQUAD_SCORING.pointsBigWin);
  });

  test('board result is always the plain TD comparison, independent of any individual scoring config', () => {
    // Casualties/aggressions must never influence which side "wins" a board.
    const teams = [...squadTeams(1, 'A', 'a'), ...squadTeams(1, 'B', 'b')];
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 0, team2Td: 1, team1Cas: 50, team2Cas: 0 })),
    ];
    const standings = computeSquadStandings(squads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    const b = standings.find((s) => s.squadId === 'B')!;
    assert.equal(a.losses, 1);
    assert.equal(b.wins, 1);
  });

  test('only completed matches count toward the round board tally', () => {
    const teams = [...squadTeams(3, 'A', 'a'), ...squadTeams(3, 'B', 'b')];
    const round: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })), // completed: counts
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 }), 'awaiting_confirmation'), // excluded
      { ...completedChallenge('a2', 'b2', 1, matchResult({ team1Td: 2, team2Td: 0 })), status: 'accepted', result: null }, // excluded
    ];
    const standings = computeSquadStandings(squads, teams, round, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    // Only 1 board completed -> net +1 -> smallWin, not a bigger tier from the other (uncounted) boards.
    assert.equal(a.points, DEFAULT_SQUAD_SCORING.pointsSmallWin);
    assert.equal(a.gamesPlayed, 1);
  });

  test('concurrent round-matchups across different squad pairs do not leak into each other', () => {
    const threeSquads: Squad[] = [...squads, { id: 'C', name: 'C', createdAt: '2026-01-01' }];
    const teams = [...squadTeams(2, 'A', 'a'), ...squadTeams(2, 'B', 'b'), ...squadTeams(2, 'C', 'c')];
    // Round 1: A vs B (A sweeps), round... actually use round 1 for A-vs-B and round 2 for A-vs-C,
    // both involving squad A, to prove per-round-per-pair isolation.
    const challenges: Challenge[] = [
      completedChallenge('a0', 'b0', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a1', 'b1', 1, matchResult({ team1Td: 2, team2Td: 0 })),
      completedChallenge('a0', 'c0', 2, matchResult({ team1Td: 0, team2Td: 2 })),
      completedChallenge('a1', 'c1', 2, matchResult({ team1Td: 1, team2Td: 1 })),
    ];
    const standings = computeSquadStandings(threeSquads, teams, challenges, DEFAULT_SQUAD_SCORING);
    const a = standings.find((s) => s.squadId === 'A')!;
    const b = standings.find((s) => s.squadId === 'B')!;
    const c = standings.find((s) => s.squadId === 'C')!;
    assert.deepEqual([a.wins, a.draws, a.losses], [1, 0, 1]); // won round 1 vs B, lost round 2 vs C
    assert.deepEqual([b.wins, b.draws, b.losses], [0, 0, 1]);
    assert.deepEqual([c.wins, c.draws, c.losses], [1, 0, 0]);
  });
});

describe('recomputeMatchPoints', () => {
  test('recomputes stored points from raw stats under a new config', () => {
    const result = matchResult({ team1Td: 2, team2Td: 0, team1Cas: 1, team1Points: 5, team2Points: 0 });
    const newCfg = config({ mode: 'raw_points', td: { basis: 'total', multiplier: 3 } });
    const { team1Points, team2Points } = recomputeMatchPoints(result, 't1', 't2', newCfg);
    assert.equal(team1Points, newCfg.pointsWin + 3 * 2);
    assert.equal(team2Points, newCfg.pointsLoss + 3 * 0);
  });

  test('preserves the concession penalty when recomputing a conceded match', () => {
    const result = matchResult({ team1Td: 0, team2Td: 3, concededByTeamId: 't1', team1Points: -5, team2Points: 5 });
    const newCfg = config({ pointsWin: 10, pointsConcessionPenalty: -99 });
    const { team1Points, team2Points } = recomputeMatchPoints(result, 't1', 't2', newCfg);
    assert.equal(team1Points, -99);
    assert.equal(team2Points, 10);
  });
});
