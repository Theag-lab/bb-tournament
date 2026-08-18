import type { Context } from 'hono';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import type { CreateTeamRequest, CreateTeamResponse, ResolveTeamResponse, Team } from '@bb-tournament/shared';
import * as storage from '../storage';
import { authenticateTeam, findTeamById, isAdmin, validatePassword } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { assetsBucketName, rosterImageKey } from '../rosterImage';

const s3 = new S3Client({});
const MAX_FIELD_LENGTH = 40;

function validateTeamInput(body: Partial<CreateTeamRequest> | null): {
  name: string;
  coachName: string;
  race: string;
  password: string;
} {
  const name = body?.name?.trim();
  const coachName = body?.coachName?.trim();
  const race = body?.race?.trim();
  if (!name) throw badRequest('Team name is required');
  if (!coachName) throw badRequest('Coach name is required');
  if (!race) throw badRequest('Race is required');
  for (const [field, value] of [['name', name], ['coachName', coachName], ['race', race]] as const) {
    if (value.length > MAX_FIELD_LENGTH) throw badRequest(`${field} must be at most ${MAX_FIELD_LENGTH} characters`);
  }
  const password = validatePassword(body?.password);
  return { name, coachName, race, password };
}

function assertCredentialsFree(
  t: { teams: Team[] },
  coachName: string,
  password: string,
  excludeTeamId?: string
): void {
  const clash = t.teams.some(
    (tm) =>
      tm.id !== excludeTeamId &&
      tm.coachName.toLowerCase() === coachName.toLowerCase() &&
      tm.password === password
  );
  if (clash) {
    throw conflict(
      'This coach name and password combination is already used by another team in this tournament',
      'credentials_taken'
    );
  }
}

export async function createTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const body = await c.req.json<CreateTeamRequest>().catch(() => null);
  const { name, coachName, race, password } = validateTeamInput(body);

  const now = new Date().toISOString();
  const newTeam: Team = {
    id: uuidv4(),
    password,
    name,
    coachName,
    race,
    createdAt: now,
    rosterImage: null,
  };

  await storage.updateTournament(tournamentId, (t) => {
    if (t.teams.some((team) => team.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`A team named "${name}" already exists in this tournament`, 'team_name_taken');
    }
    assertCredentialsFree(t, coachName, password);
    t.teams.push(newTeam);
  });

  const response: CreateTeamResponse = { teamId: newTeam.id };
  return c.json(response, 201);
}

/** "Find my team": look up by coach name + password, used when the participant has no saved link. */
export async function findMyTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const coachName = c.req.query('coachName')?.trim();
  const password = c.req.query('password');
  if (!coachName) throw badRequest('coachName is required');
  if (!password) throw unauthorized('Identifiants invalides');

  const tournament = await storage.getTournament(tournamentId);
  const normalized = coachName.toLowerCase();
  const team = tournament.teams.find((t) => t.coachName.toLowerCase() === normalized && t.password === password);
  if (!team) throw unauthorized('Identifiants invalides');

  const response: ResolveTeamResponse = {
    teamId: team.id,
    name: team.name,
    coachName: team.coachName,
    race: team.race,
  };
  return c.json(response);
}

/** Confirms a teamId + password pair from a saved/bookmarked management link. */
export async function verifyTeamAccess(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const password = c.req.query('password');

  const tournament = await storage.getTournament(tournamentId);
  const team = authenticateTeam(tournament, teamId, password);

  const response: ResolveTeamResponse = {
    teamId: team.id,
    name: team.name,
    coachName: team.coachName,
    race: team.race,
  };
  return c.json(response);
}

export async function updateTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const password = c.req.query('password');
  const token = c.req.query('token');
  const body = await c.req.json<Partial<CreateTeamRequest>>().catch(() => ({}) as Partial<CreateTeamRequest>);

  await storage.updateTournament(tournamentId, (t) => {
    const team = findTeamById(t, teamId);

    const admin = isAdmin(t, token);
    if (!admin) authenticateTeam(t, teamId, password);

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
    if (body.password !== undefined) {
      team.password = validatePassword(body.password);
    }
    if (body.coachName !== undefined || body.password !== undefined) {
      assertCredentialsFree(t, team.coachName, team.password, teamId);
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

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: assetsBucketName(), Key: rosterImageKey(tournamentId, teamId) }));
  } catch {
    // best-effort cleanup; an orphaned image object is harmless
  }

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

function requireAdminOrThrow(t: Parameters<typeof isAdmin>[0], token: string | undefined) {
  if (!isAdmin(t, token)) throw unauthorized('Admin token required');
}
