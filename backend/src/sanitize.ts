import { AdminTournamentView, PublicTournament, Tournament, computeStandings } from '@bb-tournament/shared';

/**
 * Team rosters (name/coach/race/image) stay hidden from other participants until round 1 launches
 * — but only in pure 'swiss' mode (a blind random draw). In 'swiss_with_challenge', coaches must
 * see each other to choose who to challenge before round 1, so hiding would defeat the mode's
 * whole point; those tournaments show teams from the start, same as 'ladder'.
 */
function teamsHiddenFromOthers(t: Tournament): boolean {
  if (t.mode !== 'swiss') return false;
  const round1 = t.rounds.find((r) => r.number === 1);
  return !round1 || round1.status !== 'launched';
}

export function toPublicTournament(t: Tournament, viewerTeamId: string | null = null): PublicTournament {
  const hideOthers = teamsHiddenFromOthers(t);
  const launchedRounds = new Set(t.rounds.filter((r) => r.status === 'launched').map((r) => r.number));

  return {
    id: t.id,
    name: t.name,
    description: t.description,
    requireRosterValidation: t.requireRosterValidation,
    mode: t.mode,
    roundCount: t.roundCount,
    // Round metadata (number + draft/launched status) never leaks pairing details, so it's
    // always shown — this lets the frontend know e.g. registration is closed while a draft
    // round is still being prepared, without exposing who's actually paired with whom yet.
    rounds: t.rounds,
    createdAt: t.createdAt,
    teams: t.teams.map((team) => {
      const masked = hideOthers && team.id !== viewerTeamId;
      return {
        id: team.id,
        name: masked ? 'Équipe masquée' : team.name,
        coachName: masked ? '—' : team.coachName,
        race: masked ? '—' : team.race,
        createdAt: team.createdAt,
        rosterImage: masked ? null : team.rosterImage,
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
    standings: computeStandings(t.teams, t.challenges),
  };
}

export function toAdminTournamentView(t: Tournament): AdminTournamentView {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    requireRosterValidation: t.requireRosterValidation,
    mode: t.mode,
    roundCount: t.roundCount,
    rounds: t.rounds,
    createdAt: t.createdAt,
    teams: t.teams.map((team) => ({
      id: team.id,
      name: team.name,
      coachName: team.coachName,
      race: team.race,
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
    standings: computeStandings(t.teams, t.challenges),
  };
}
