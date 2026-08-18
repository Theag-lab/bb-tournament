import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { CreateTeamRequest, CreateTeamResponse, Team } from '@bb-tournament/shared';
import * as storage from '../storage';
import { isAdmin } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';

const MAX_FIELD_LENGTH = 40;

function validateTeamInput(body: Partial<CreateTeamRequest> | null): { name: string; coachName: string; race: string } {
  const name = body?.name?.trim();
  const coachName = body?.coachName?.trim();
  const race = body?.race?.trim();
  if (!name) throw badRequest('Team name is required');
  if (!coachName) throw badRequest('Coach name is required');
  if (!race) throw badRequest('Race is required');
  for (const [field, value] of [['name', name], ['coachName', coachName], ['race', race]] as const) {
    if (value.length > MAX_FIELD_LENGTH) throw badRequest(`${field} must be at most ${MAX_FIELD_LENGTH} characters`);
  }
  return { name, coachName, race };
}

export async function createTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const body = await c.req.json<CreateTeamRequest>().catch(() => null);
  const { name, coachName, race } = validateTeamInput(body);

  const now = new Date().toISOString();
  const newTeam: Team = {
    id: uuidv4(),
    participantToken: uuidv4(),
    name,
    coachName,
    race,
    createdAt: now,
  };

  await storage.updateTournament(tournamentId, (t) => {
    if (t.teams.some((team) => team.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`A team named "${name}" already exists in this tournament`, 'team_name_taken');
    }
    t.teams.push(newTeam);
  });

  const response: CreateTeamResponse = {
    teamId: newTeam.id,
    participantToken: newTeam.participantToken,
  };
  return c.json(response, 201);
}

export async function updateTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const token = c.req.query('token');
  const body = await c.req.json<Partial<CreateTeamRequest>>().catch(() => ({}) as Partial<CreateTeamRequest>);

  await storage.updateTournament(tournamentId, (t) => {
    const team = t.teams.find((tm) => tm.id === teamId);
    if (!team) throw notFound('Team not found');

    const admin = isAdmin(t, token);
    if (!admin && team.participantToken !== token) throw unauthorized('Invalid token for this team');

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) throw badRequest('Team name is required');
      if (name.length > MAX_FIELD_LENGTH) throw badRequest(`name must be at most ${MAX_FIELD_LENGTH} characters`);
      if (t.teams.some((tm) => tm.id !== teamId && tm.name.toLowerCase() === name.toLowerCase())) {
        throw conflict(`A team named "${name}" already exists in this tournament`, 'team_name_taken');
      }
      team.name = name;
    }
    if (body.coachName !== undefined) {
      const coachName = body.coachName.trim();
      if (!coachName) throw badRequest('Coach name is required');
      team.coachName = coachName;
    }
    if (body.race !== undefined) {
      const race = body.race.trim();
      if (!race) throw badRequest('Race is required');
      team.race = race;
    }
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament));
}

export async function deleteTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdminOrThrow(t, token);
    const team = t.teams.find((tm) => tm.id === teamId);
    if (!team) throw notFound('Team not found');
    const hasChallenges = t.challenges.some((ch) => ch.team1Id === teamId || ch.team2Id === teamId);
    if (hasChallenges) {
      throw forbidden('Cannot delete a team that already has challenges; cancel/resolve them first');
    }
    t.teams = t.teams.filter((tm) => tm.id !== teamId);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

function requireAdminOrThrow(t: Parameters<typeof isAdmin>[0], token: string | undefined) {
  if (!isAdmin(t, token)) throw unauthorized('Admin token required');
}
