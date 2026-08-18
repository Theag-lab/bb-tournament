import { Challenge, StandingEntry, SubmitResultRequest, Team } from './types';

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
      team1Points: team1Conceded ? POINTS_CONCESSION : POINTS_WIN,
      team2Points: team1Conceded ? POINTS_WIN : POINTS_CONCESSION,
    };
  }

  const team1Td = Math.max(0, Math.trunc(input.team1Td));
  const team2Td = Math.max(0, Math.trunc(input.team2Td));
  const team1Cas = Math.max(0, Math.trunc(input.team1Cas));
  const team2Cas = Math.max(0, Math.trunc(input.team2Cas));

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

  return { team1Td, team2Td, team1Cas, team2Cas, team1Points, team2Points };
}

/**
 * Standings ordering follows the PDF's individual tiebreaker order:
 * points, then fewest touchdowns conceded, then net touchdowns, then net casualties.
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
      gamesPlayed: 0,
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

  return Array.from(byTeam.values()).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (a.tdAgainst !== b.tdAgainst) return a.tdAgainst - b.tdAgainst; // fewest TD conceded first
    const netTdA = a.tdFor - a.tdAgainst;
    const netTdB = b.tdFor - b.tdAgainst;
    if (netTdB !== netTdA) return netTdB - netTdA;
    const netCasA = a.casFor - a.casAgainst;
    const netCasB = b.casFor - b.casAgainst;
    if (netCasB !== netCasA) return netCasB - netCasA;
    return 0;
  });
}
