import {
  AdminTournamentView,
  CustomStatLeaderboard,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_MATCH_SHEET_CONFIG,
  DEFAULT_ROUND_TIMER,
  DEFAULT_SQUAD_SCORING,
  PoolStandingEntry,
  PublicTournament,
  SquadStandingEntry,
  Tournament,
  computeCustomStatLeaderboards,
  computeSquadStandings,
  computeStandings,
} from '@bb-tournament/shared';
import { buildBracketView, getKnockoutChampion } from './bracket';

function squadStandingsOf(t: Tournament): SquadStandingEntry[] {
  if (t.format !== 'team') return [];
  return computeSquadStandings(t.squads, t.teams, t.challenges, t.squadScoring ?? DEFAULT_SQUAD_SCORING);
}

function customStatLeaderboardsOf(t: Tournament): CustomStatLeaderboard[] {
  return computeCustomStatLeaderboards(t.teams, t.challenges, t.customStatCategories ?? []);
}

/** Pool-scoped standings, only populated for 'pools_knockout' mode tournaments. */
function poolStandingsOf(t: Tournament): PoolStandingEntry[] {
  if (t.mode !== 'pools_knockout') return [];
  const config = t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING;
  const customStatCategories = t.customStatCategories ?? [];
  return t.pools.map((pool) => ({
    poolId: pool.id,
    standings: computeStandings(
      t.teams.filter((tm) => tm.poolId === pool.id),
      t.challenges,
      config,
      customStatCategories
    ),
  }));
}

/**
 * Roster *image and race* stay hidden from other participants until round 1 launches, in both
 * swiss modes — this is the actual "scouting" concern (seeing an opponent's exact roster build
 * or race/matchup before pairings are locked in). Team name/coach are NOT hidden: in
 * swiss_with_challenge coaches need them to pick who to challenge, and knowing who's in the
 * tournament isn't a fairness issue the way seeing their race or roster sheet is.
 */
function rosterDetailsHiddenFromOthers(t: Tournament): boolean {
  if (t.mode === 'ladder') return false;
  const round1 = t.rounds.find((r) => r.number === 1);
  return !round1 || round1.status !== 'launched';
}

export function toPublicTournament(t: Tournament, viewerTeamId: string | null = null): PublicTournament {
  const hideRosterDetails = rosterDetailsHiddenFromOthers(t);
  const launchedRounds = new Set(t.rounds.filter((r) => r.status === 'launched').map((r) => r.number));
  const bracket = buildBracketView(t);

  return {
    id: t.id,
    name: t.name,
    description: t.description,
    organizerCoachName: t.organizerCoachName || t.name,
    requireRosterValidation: t.requireRosterValidation,
    requireResultConfirmation: t.requireResultConfirmation ?? true,
    showTeamNames: t.showTeamNames ?? true,
    mode: t.mode,
    roundCount: t.roundCount,
    // Round metadata (number + draft/launched status) never leaks pairing details, so it's
    // always shown — this lets the frontend know e.g. registration is closed while a draft
    // round is still being prepared, without exposing who's actually paired with whom yet.
    rounds: t.rounds,
    format: t.format,
    squadSize: t.squadSize,
    squadScoring: t.squadScoring,
    squads: t.squads,
    poolSize: t.poolSize,
    poolRoundCount: t.poolRoundCount,
    qualifiersPerPool: t.qualifiersPerPool,
    pools: t.pools,
    individualScoring: t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
    matchSheetConfig: t.matchSheetConfig ?? DEFAULT_MATCH_SHEET_CONFIG,
    customStatCategories: t.customStatCategories ?? [],
    roundTimer: t.roundTimer ?? DEFAULT_ROUND_TIMER,
    createdAt: t.createdAt,
    teams: t.teams.map((team) => {
      const hideDetails = hideRosterDetails && team.id !== viewerTeamId;
      return {
        id: team.id,
        name: team.name,
        coachName: team.coachName,
        race: hideDetails ? '—' : team.race,
        nafNumber: team.nafNumber,
        squadId: team.squadId,
        poolId: team.poolId,
        createdAt: team.createdAt,
        rosterImage: hideDetails ? null : team.rosterImage,
        rosterStatus: team.rosterStatus,
      };
    }),
    challenges: t.challenges
      .filter((c) => c.round === null || launchedRounds.has(c.round))
      .map((c) => ({
        id: c.id,
        team1Id: c.team1Id,
        team2Id: c.team2Id,
        status: c.status,
        round: c.round,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        result: c.result,
      })),
    standings: computeStandings(t.teams, t.challenges, t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, t.customStatCategories ?? []),
    squadStandings: squadStandingsOf(t),
    poolStandings: poolStandingsOf(t),
    customStatLeaderboards: customStatLeaderboardsOf(t),
    bracket,
    knockoutChampionTeamId: getKnockoutChampion(bracket),
  };
}

export function toAdminTournamentView(t: Tournament): AdminTournamentView {
  const bracket = buildBracketView(t);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    organizerCoachName: t.organizerCoachName || t.name,
    requireRosterValidation: t.requireRosterValidation,
    requireResultConfirmation: t.requireResultConfirmation ?? true,
    showTeamNames: t.showTeamNames ?? true,
    mode: t.mode,
    roundCount: t.roundCount,
    rounds: t.rounds,
    format: t.format,
    squadSize: t.squadSize,
    squadScoring: t.squadScoring,
    squads: t.squads,
    poolSize: t.poolSize,
    poolRoundCount: t.poolRoundCount,
    qualifiersPerPool: t.qualifiersPerPool,
    pools: t.pools,
    individualScoring: t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING,
    matchSheetConfig: t.matchSheetConfig ?? DEFAULT_MATCH_SHEET_CONFIG,
    customStatCategories: t.customStatCategories ?? [],
    roundTimer: t.roundTimer ?? DEFAULT_ROUND_TIMER,
    createdAt: t.createdAt,
    teams: t.teams.map((team) => ({
      id: team.id,
      name: team.name,
      coachName: team.coachName,
      race: team.race,
      nafNumber: team.nafNumber,
      squadId: team.squadId,
      poolId: team.poolId,
      createdAt: team.createdAt,
      rosterImage: team.rosterImage,
      rosterStatus: team.rosterStatus,
      password: team.password,
    })),
    challenges: t.challenges.map((c) => ({
      id: c.id,
      team1Id: c.team1Id,
      team2Id: c.team2Id,
      status: c.status,
      round: c.round,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      result: c.result,
    })),
    standings: computeStandings(t.teams, t.challenges, t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, t.customStatCategories ?? []),
    squadStandings: squadStandingsOf(t),
    poolStandings: poolStandingsOf(t),
    customStatLeaderboards: customStatLeaderboardsOf(t),
    bracket,
    knockoutChampionTeamId: getKnockoutChampion(bracket),
  };
}
