import { AdminTournamentView, PublicTournament, Tournament, computeStandings } from '@bb-tournament/shared';

export function toPublicTournament(t: Tournament): PublicTournament {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    createdAt: t.createdAt,
    teams: t.teams.map((team) => ({
      id: team.id,
      name: team.name,
      coachName: team.coachName,
      race: team.race,
      createdAt: team.createdAt,
      rosterImage: team.rosterImage,
    })),
    challenges: t.challenges.map((c) => ({
      id: c.id,
      team1Id: c.team1Id,
      team2Id: c.team2Id,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      result: c.result,
    })),
    standings: computeStandings(t.teams, t.challenges),
  };
}

export function toAdminTournamentView(t: Tournament): AdminTournamentView {
  const pub = toPublicTournament(t);
  return {
    ...pub,
    teams: t.teams.map((team) => ({
      id: team.id,
      name: team.name,
      coachName: team.coachName,
      race: team.race,
      createdAt: team.createdAt,
      rosterImage: team.rosterImage,
      password: team.password,
    })),
  };
}
