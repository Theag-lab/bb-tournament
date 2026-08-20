import { Challenge, Squad, SquadScoringConfig, SquadStandingEntry, StandingEntry, SubmitResultRequest, Team } from './types';

export const POINTS_WIN = 5;
export const POINTS_DRAW = 2;
export const POINTS_LOSS = 0;
export const POINTS_CONCESSION = -5;
export const CONCESSION_SCORE = 3;

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

/**
 * Applies NAF-style concession handling (forced 3-0 in the winner's favor)
 * and computes tournament points from the final score.
 */
export function computeMatchScore(
  input: SubmitResultRequest,
  team1Id: string,
  team2Id: string
): ComputedScore {
  if (input.concededByTeamId) {
    if (input.concededByTeamId !== team1Id && input.concededByTeamId !== team2Id) {
      throw new Error('concededByTeamId must be one of the two teams in the match');
    }
    const team1Conceded = input.concededByTeamId === team1Id;
    return {
      team1Td: team1Conceded ? 0 : CONCESSION_SCORE,
      team2Td: team1Conceded ? CONCESSION_SCORE : 0,
      team1Cas: team1Conceded ? 0 : CONCESSION_SCORE,
      team2Cas: team1Conceded ? CONCESSION_SCORE : 0,
      team1Agg: team1Conceded ? 0 : CONCESSION_SCORE,
      team2Agg: team1Conceded ? CONCESSION_SCORE : 0,
      team1Points: team1Conceded ? POINTS_CONCESSION : POINTS_WIN,
      team2Points: team1Conceded ? POINTS_WIN : POINTS_CONCESSION,
    };
  }

  const team1Td = Math.max(0, Math.trunc(input.team1Td));
  const team2Td = Math.max(0, Math.trunc(input.team2Td));
  const team1Cas = Math.max(0, Math.trunc(input.team1Cas));
  const team2Cas = Math.max(0, Math.trunc(input.team2Cas));
  const team1Agg = Math.max(0, Math.trunc(input.team1Agg));
  const team2Agg = Math.max(0, Math.trunc(input.team2Agg));

  let team1Points: number;
  let team2Points: number;
  if (team1Td > team2Td) {
    team1Points = POINTS_WIN;
    team2Points = POINTS_LOSS;
  } else if (team2Td > team1Td) {
    team1Points = POINTS_LOSS;
    team2Points = POINTS_WIN;
  } else {
    team1Points = POINTS_DRAW;
    team2Points = POINTS_DRAW;
  }

  return { team1Td, team2Td, team1Cas, team2Cas, team1Agg, team2Agg, team1Points, team2Points };
}

/**
 * A stable, deterministic stand-in for a physical "random draw" tiebreak: the same pair of teams
 * always resolves the same way (so standings don't reshuffle on every poll), while carrying no
 * relationship to anything meaningful about the team — an arbitrary but fixed coin-flip result.
 */
function stableRandomKey(teamId: string): number {
  let hash = 0;
  for (let i = 0; i < teamId.length; i++) {
    hash = (hash * 31 + teamId.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Standings ordering follows the PDF's individual tiebreaker order exactly: points, then fewest
 * touchdowns conceded, then opponent score (sum of opponents' final points — a Buchholz-style
 * strength-of-schedule measure), then net touchdowns, then random draw, then net casualties.
 */
export function computeStandings(teams: Team[], challenges: Challenge[]): StandingEntry[] {
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

    if (r.team1Points > r.team2Points) {
      s1.wins += 1;
      s2.losses += 1;
    } else if (r.team2Points > r.team1Points) {
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

  return Array.from(byTeam.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.tdAgainst !== b.tdAgainst) return a.tdAgainst - b.tdAgainst; // fewest TD conceded first
    if (b.opponentScore !== a.opponentScore) return b.opponentScore - a.opponentScore;
    const netTdA = a.tdFor - a.tdAgainst;
    const netTdB = b.tdFor - b.tdAgainst;
    if (netTdB !== netTdA) return netTdB - netTdA;
    const randomA = stableRandomKey(a.teamId);
    const randomB = stableRandomKey(b.teamId);
    if (randomA !== randomB) return randomA - randomB;
    const netCasA = a.casFor - a.casAgainst;
    const netCasB = b.casFor - b.casAgainst;
    if (netCasB !== netCasA) return netCasB - netCasA;
    return 0;
  });
}

/**
 * Maps one side's TD-difference (positive = that side won by this much) to the squad points for
 * its match-result tier, per the organiser-configured SquadScoringConfig. Asymmetric by design:
 * the win side has 3 tiers (small/plain/total), the loss side only 2 (small/plain) — see
 * SquadScoringConfig's doc comment.
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
 * by each squad's member teams. Squad score comes from `squadPointsForDiff`, not the individual
 * W/D/L points used by `computeStandings` — the two are independent scoring systems.
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

  for (const challenge of challenges) {
    if (challenge.status !== 'completed' || !challenge.result) continue;
    const r = challenge.result;
    const squad1Id = squadOfTeam.get(challenge.team1Id);
    const squad2Id = squadOfTeam.get(challenge.team2Id);
    if (!squad1Id || !squad2Id) continue;
    const e1 = byId.get(squad1Id);
    const e2 = byId.get(squad2Id);
    if (!e1 || !e2) continue;

    const diff = r.team1Td - r.team2Td;
    e1.points += squadPointsForDiff(diff, scoring);
    e2.points += squadPointsForDiff(-diff, scoring);
    if (diff > 0) {
      e1.wins += 1;
      e2.losses += 1;
    } else if (diff < 0) {
      e2.wins += 1;
      e1.losses += 1;
    } else {
      e1.draws += 1;
      e2.draws += 1;
    }
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
