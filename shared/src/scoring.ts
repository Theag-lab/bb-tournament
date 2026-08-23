import {
  Challenge,
  IndividualScoringConfig,
  MatchResult,
  RawPointsComponent,
  Squad,
  SquadScoringConfig,
  SquadStandingEntry,
  StandingEntry,
  SubmitResultRequest,
  Team,
  TiebreakerCriterion,
} from './types';

export const CONCESSION_SCORE = 3;

/**
 * Reproduces the historical fixed scoring exactly (5/2/0 points, -5 concession penalty, and the
 * tiebreaker order that used to be hardcoded into computeStandings' sort comparator), so
 * tournaments created before this config existed keep behaving identically until an admin
 * deliberately changes it.
 */
export const DEFAULT_INDIVIDUAL_SCORING: IndividualScoringConfig = {
  mode: 'points_tiebreaker',
  pointsWin: 5,
  pointsDraw: 2,
  pointsLoss: 0,
  pointsConcessionPenalty: -5,
  tiebreakers: ['fewest_td_conceded', 'opponent_score', 'net_td', 'random', 'net_cas'],
  td: { basis: 'diff', multiplier: 0 },
  cas: { basis: 'diff', multiplier: 0 },
  agg: { basis: 'diff', multiplier: 0 },
};

export interface ComputedScore {
  team1Td: number;
  team2Td: number;
  team1Cas: number;
  team2Cas: number;
  team1Agg: number;
  team2Agg: number;
  team1Points: number;
  team2Points: number;
}

/** One side's contribution from a raw-points component (0 if the component is disabled via multiplier 0). */
function rawPointsComponentValue(component: RawPointsComponent, forValue: number, againstValue: number): number {
  const base = component.basis === 'diff' ? forValue - againstValue : forValue;
  return base * component.multiplier;
}

/**
 * The win/draw/loss points for one side, given its classic outcome (always decided by TD
 * comparison, regardless of scoring mode) and whether it's the side that conceded.
 */
function outcomePoints(
  config: IndividualScoringConfig,
  outcome: 'win' | 'draw' | 'loss',
  conceded: boolean
): number {
  if (conceded) return config.pointsConcessionPenalty;
  if (outcome === 'win') return config.pointsWin;
  if (outcome === 'draw') return config.pointsDraw;
  return config.pointsLoss;
}

/** Points for both sides of a match, given its final (post-concession-forced) stats. */
function computePointsFromStats(
  config: IndividualScoringConfig,
  team1Td: number,
  team2Td: number,
  team1Cas: number,
  team2Cas: number,
  team1Agg: number,
  team2Agg: number,
  team1Conceded: boolean,
  team2Conceded: boolean
): { team1Points: number; team2Points: number } {
  const outcome1: 'win' | 'draw' | 'loss' = team1Td > team2Td ? 'win' : team2Td > team1Td ? 'loss' : 'draw';
  const outcome2: 'win' | 'draw' | 'loss' = outcome1 === 'win' ? 'loss' : outcome1 === 'loss' ? 'win' : 'draw';

  let team1Points = outcomePoints(config, outcome1, team1Conceded);
  let team2Points = outcomePoints(config, outcome2, team2Conceded);

  if (config.mode === 'raw_points') {
    team1Points +=
      rawPointsComponentValue(config.td, team1Td, team2Td) +
      rawPointsComponentValue(config.cas, team1Cas, team2Cas) +
      rawPointsComponentValue(config.agg, team1Agg, team2Agg);
    team2Points +=
      rawPointsComponentValue(config.td, team2Td, team1Td) +
      rawPointsComponentValue(config.cas, team2Cas, team1Cas) +
      rawPointsComponentValue(config.agg, team2Agg, team1Agg);
  }

  return { team1Points, team2Points };
}

/**
 * Applies NAF-style concession handling (forced 3-0 in the winner's favor)
 * and computes tournament points from the final score, per the tournament's IndividualScoringConfig.
 */
export function computeMatchScore(
  input: SubmitResultRequest,
  team1Id: string,
  team2Id: string,
  config: IndividualScoringConfig
): ComputedScore {
  let team1Td: number, team2Td: number, team1Cas: number, team2Cas: number, team1Agg: number, team2Agg: number;
  let team1Conceded = false;
  let team2Conceded = false;

  if (input.concededByTeamId) {
    if (input.concededByTeamId !== team1Id && input.concededByTeamId !== team2Id) {
      throw new Error('concededByTeamId must be one of the two teams in the match');
    }
    team1Conceded = input.concededByTeamId === team1Id;
    team2Conceded = !team1Conceded;
    team1Td = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Td = team1Conceded ? CONCESSION_SCORE : 0;
    team1Cas = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Cas = team1Conceded ? CONCESSION_SCORE : 0;
    team1Agg = team1Conceded ? 0 : CONCESSION_SCORE;
    team2Agg = team1Conceded ? CONCESSION_SCORE : 0;
  } else {
    team1Td = Math.max(0, Math.trunc(input.team1Td));
    team2Td = Math.max(0, Math.trunc(input.team2Td));
    team1Cas = Math.max(0, Math.trunc(input.team1Cas));
    team2Cas = Math.max(0, Math.trunc(input.team2Cas));
    team1Agg = Math.max(0, Math.trunc(input.team1Agg));
    team2Agg = Math.max(0, Math.trunc(input.team2Agg));
  }

  const { team1Points, team2Points } = computePointsFromStats(
    config,
    team1Td,
    team2Td,
    team1Cas,
    team2Cas,
    team1Agg,
    team2Agg,
    team1Conceded,
    team2Conceded
  );

  return { team1Td, team2Td, team1Cas, team2Cas, team1Agg, team2Agg, team1Points, team2Points };
}

/**
 * Recomputes a completed match's team1Points/team2Points from its already-recorded raw stats,
 * per a (possibly newly-changed) IndividualScoringConfig — used when the admin edits the
 * tournament's scoring config, so already-played matches immediately reflect the new rules instead
 * of staying frozen at whatever config was active when they were submitted.
 */
export function recomputeMatchPoints(
  result: MatchResult,
  team1Id: string,
  team2Id: string,
  config: IndividualScoringConfig
): { team1Points: number; team2Points: number } {
  const team1Conceded = result.concededByTeamId === team1Id;
  const team2Conceded = result.concededByTeamId === team2Id;
  return computePointsFromStats(
    config,
    result.team1Td,
    result.team2Td,
    result.team1Cas,
    result.team2Cas,
    result.team1Agg,
    result.team2Agg,
    team1Conceded,
    team2Conceded
  );
}

/**
 * A stable, deterministic stand-in for a physical "random draw" tiebreak: the same pair of teams
 * always resolves the same way (so standings don't reshuffle on every poll), while carrying no
 * relationship to anything meaningful about the team — an arbitrary but fixed coin-flip result.
 */
export function stableRandomKey(teamId: string): number {
  let hash = 0;
  for (let i = 0; i < teamId.length; i++) {
    hash = (hash * 31 + teamId.charCodeAt(i)) | 0;
  }
  return hash;
}

/** One comparator per selectable TiebreakerCriterion except 'head_to_head', which needs the
 * match list rather than just the two aggregate StandingEntry — handled separately below.
 * More info wins (returns < 0 means `a` ranks first). */
const TIEBREAKER_COMPARATORS: Record<Exclude<TiebreakerCriterion, 'head_to_head'>, (a: StandingEntry, b: StandingEntry) => number> = {
  fewest_td_conceded: (a, b) => a.tdAgainst - b.tdAgainst,
  opponent_score: (a, b) => b.opponentScore - a.opponentScore,
  net_td: (a, b) => b.tdFor - b.tdAgainst - (a.tdFor - a.tdAgainst),
  net_cas: (a, b) => b.casFor - b.casAgainst - (a.casFor - a.casAgainst),
  net_agg: (a, b) => b.aggFor - b.aggAgainst - (a.aggFor - a.aggAgainst),
  random: (a, b) => stableRandomKey(a.teamId) - stableRandomKey(b.teamId),
};

/**
 * Resolves head-to-head dominance between exactly two teams from their completed meetings only:
 * the team with strictly more wins over the other (by classic TD comparison, independent of the
 * scoring mode) wins it. Returns null when they never met, or split their meetings evenly
 * (including the degenerate "met once and drew" case) — there's no signal to act on either way, so
 * this tiebreaker criterion falls through to the next one.
 */
export function headToHeadWinner(challenges: Challenge[], teamAId: string, teamBId: string): string | null {
  let aWins = 0;
  let bWins = 0;
  for (const c of challenges) {
    if (c.status !== 'completed' || !c.result) continue;
    const involvesA = c.team1Id === teamAId || c.team2Id === teamAId;
    const involvesB = c.team1Id === teamBId || c.team2Id === teamBId;
    if (!involvesA || !involvesB) continue;
    const r = c.result;
    if (r.team1Td === r.team2Td) continue; // drew this meeting, no signal from it
    const winnerId = r.team1Td > r.team2Td ? c.team1Id : c.team2Id;
    if (winnerId === teamAId) aWins++;
    else if (winnerId === teamBId) bWins++;
  }
  if (aWins === bWins) return null;
  return aWins > bWins ? teamAId : teamBId;
}

function compareHeadToHead(challenges: Challenge[], a: StandingEntry, b: StandingEntry): number {
  const winner = headToHeadWinner(challenges, a.teamId, b.teamId);
  if (winner === a.teamId) return -1;
  if (winner === b.teamId) return 1;
  return 0;
}

/**
 * Standings ordering: total points first, per `config`. In 'points_tiebreaker' mode, ties are then
 * broken by `config.tiebreakers` in order; in 'raw_points' mode there are no configured
 * tiebreakers (the score itself already encodes TD/CAS/Agg), so this only falls through to the
 * final stable-random tiebreak added for full determinism.
 */
export function computeStandings(teams: Team[], challenges: Challenge[], config: IndividualScoringConfig): StandingEntry[] {
  const byTeam = new Map<string, StandingEntry>();
  for (const team of teams) {
    byTeam.set(team.id, {
      teamId: team.id,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      tdFor: 0,
      tdAgainst: 0,
      casFor: 0,
      casAgainst: 0,
      aggFor: 0,
      aggAgainst: 0,
      gamesPlayed: 0,
      opponentScore: 0,
    });
  }

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    const s1 = byTeam.get(challenge.team1Id);
    const s2 = byTeam.get(challenge.team2Id);
    if (!s1 || !s2) continue;

    s1.points += r.team1Points;
    s2.points += r.team2Points;
    s1.tdFor += r.team1Td;
    s1.tdAgainst += r.team2Td;
    s2.tdFor += r.team2Td;
    s2.tdAgainst += r.team1Td;
    s1.casFor += r.team1Cas;
    s1.casAgainst += r.team2Cas;
    s2.casFor += r.team2Cas;
    s2.casAgainst += r.team1Cas;
    s1.aggFor += r.team1Agg;
    s1.aggAgainst += r.team2Agg;
    s2.aggFor += r.team2Agg;
    s2.aggAgainst += r.team1Agg;
    s1.gamesPlayed += 1;
    s2.gamesPlayed += 1;

    // W/D/L is always the classic TD-based outcome, independent of the scoring mode/config — a
    // team's record shouldn't change just because the admin tweaks how many points a win is worth.
    if (r.team1Td > r.team2Td) {
      s1.wins += 1;
      s2.losses += 1;
    } else if (r.team2Td > r.team1Td) {
      s2.wins += 1;
      s1.losses += 1;
    } else {
      s1.draws += 1;
      s2.draws += 1;
    }
  }

  // Opponent score (Buchholz) needs every team's FINAL points, so it's a second pass over the
  // now-fully-accumulated standings rather than something foldable into the loop above.
  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const s1 = byTeam.get(challenge.team1Id);
    const s2 = byTeam.get(challenge.team2Id);
    if (!s1 || !s2) continue;
    s1.opponentScore += s2.points;
    s2.opponentScore += s1.points;
  }

  const criteria = config.mode === 'points_tiebreaker' ? config.tiebreakers : [];
  return Array.from(byTeam.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    for (const criterion of criteria) {
      const cmp = criterion === 'head_to_head' ? compareHeadToHead(challenges, a, b) : TIEBREAKER_COMPARATORS[criterion](a, b);
      if (cmp !== 0) return cmp;
    }
    // Final deterministic fallback so equal totals never leave the order ambiguous, even if
    // 'random' wasn't explicitly configured (or raw_points mode, which has no tiebreaker list).
    return TIEBREAKER_COMPARATORS.random(a, b);
  });
}

/**
 * Maps one side's net board differential for a round (boards won minus boards lost, positive =
 * that side won more boards) to its squad points for that round's tier, per the
 * organiser-configured SquadScoringConfig. Asymmetric by design: the win side has 3 tiers
 * (small/plain/total), the loss side only 2 (small/plain) — see SquadScoringConfig's doc comment.
 */
function squadPointsForDiff(diff: number, cfg: SquadScoringConfig): number {
  if (diff === 0) return cfg.pointsDraw;
  const abs = Math.abs(diff);
  if (diff > 0) {
    if (abs >= cfg.bigMarginMinDiff) return cfg.pointsBigWin;
    if (abs > cfg.smallMarginMaxDiff) return cfg.pointsWin;
    return cfg.pointsSmallWin;
  }
  return abs > cfg.smallMarginMaxDiff ? cfg.pointsLoss : cfg.pointsSmallLoss;
}

/**
 * Squad-level standings for 'team' format tournaments: aggregates every completed match played
 * by each squad's member teams. Squad score/tier comes from `squadPointsForDiff`, not the
 * individual W/D/L points used by `computeStandings` — the two are independent scoring systems.
 *
 * W/D/L and tier points are per ROUND, not per individual match: each round a squad plays exactly
 * one opposing squad (its members' matches are the "boards" of that one round-matchup, like a
 * chess team match). A round's tier is decided by the squad's net BOARD differential — boards won
 * minus boards lost that round, each board's own win/draw/loss always by plain TD comparison — not
 * by TD-difference or points margin of any single match. E.g. sweeping 5-0-0 (diff +5) is a bigger
 * win than squeaking by 3-2-0 (diff +1), even though both are "the squad won more boards than it
 * lost"; `squadPointsForDiff` buckets that differential into the 6 configured tiers.
 */
export function computeSquadStandings(
  squads: Squad[],
  teams: Team[],
  challenges: Challenge[],
  scoring: SquadScoringConfig
): SquadStandingEntry[] {
  const squadOfTeam = new Map(teams.map((t) => [t.id, t.squadId]));
  const byId = new Map<string, SquadStandingEntry>();
  for (const squad of squads) {
    byId.set(squad.id, {
      squadId: squad.id,
      points: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      tdFor: 0,
      tdAgainst: 0,
      casFor: 0,
      casAgainst: 0,
      aggFor: 0,
      aggAgainst: 0,
      gamesPlayed: 0,
    });
  }

  // Per-round squad-vs-squad matchup board tallies, keyed so both member pairings of the same
  // round land in the same bucket regardless of which squad is team1/team2 on a given match.
  interface RoundMatchup {
    squadA: string;
    squadB: string;
    boardWinsA: number;
    boardLossesA: number;
  }
  const roundMatchups = new Map<string, RoundMatchup>();

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    const squad1Id = squadOfTeam.get(challenge.team1Id);
    const squad2Id = squadOfTeam.get(challenge.team2Id);
    if (!squad1Id || !squad2Id) continue;
    const e1 = byId.get(squad1Id);
    const e2 = byId.get(squad2Id);
    if (!e1 || !e2) continue;

    e1.tdFor += r.team1Td;
    e1.tdAgainst += r.team2Td;
    e2.tdFor += r.team2Td;
    e2.tdAgainst += r.team1Td;
    e1.casFor += r.team1Cas;
    e1.casAgainst += r.team2Cas;
    e2.casFor += r.team2Cas;
    e2.casAgainst += r.team1Cas;
    e1.aggFor += r.team1Agg;
    e1.aggAgainst += r.team2Agg;
    e2.aggFor += r.team2Agg;
    e2.aggAgainst += r.team1Agg;
    e1.gamesPlayed += 1;
    e2.gamesPlayed += 1;

    if (squad1Id === squad2Id) continue; // shouldn't happen, but guard against self-matchup skew
    const [squadA, squadB] = squad1Id < squad2Id ? [squad1Id, squad2Id] : [squad2Id, squad1Id];
    const key = `${challenge.round}:${squadA}:${squadB}`;
    let matchup = roundMatchups.get(key);
    if (!matchup) {
      matchup = { squadA, squadB, boardWinsA: 0, boardLossesA: 0 };
      roundMatchups.set(key, matchup);
    }
    // Board result is always the plain TD comparison — independent of any scoring config.
    const boardOutcomeForSquad1 = r.team1Td > r.team2Td ? 1 : r.team1Td < r.team2Td ? -1 : 0;
    const boardOutcomeForA = squad1Id === squadA ? boardOutcomeForSquad1 : -boardOutcomeForSquad1;
    if (boardOutcomeForA > 0) matchup.boardWinsA += 1;
    else if (boardOutcomeForA < 0) matchup.boardLossesA += 1;
  }

  for (const { squadA, squadB, boardWinsA, boardLossesA } of roundMatchups.values()) {
    const eA = byId.get(squadA);
    const eB = byId.get(squadB);
    if (!eA || !eB) continue;
    const netBoardsA = boardWinsA - boardLossesA;
    eA.points += squadPointsForDiff(netBoardsA, scoring);
    eB.points += squadPointsForDiff(-netBoardsA, scoring);
    if (netBoardsA > 0) {
      eA.wins += 1;
      eB.losses += 1;
    } else if (netBoardsA < 0) {
      eB.wins += 1;
      eA.losses += 1;
    } else {
      eA.draws += 1;
      eB.draws += 1;
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const netTdA = a.tdFor - a.tdAgainst;
    const netTdB = b.tdFor - b.tdAgainst;
    if (netTdB !== netTdA) return netTdB - netTdA;
    const netCasA = a.casFor - a.casAgainst;
    const netCasB = b.casFor - b.casAgainst;
    if (netCasB !== netCasA) return netCasB - netCasA;
    const randomA = stableRandomKey(a.squadId);
    const randomB = stableRandomKey(b.squadId);
    return randomA - randomB;
  });
}
