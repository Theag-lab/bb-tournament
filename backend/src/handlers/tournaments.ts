import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  type CreateTournamentRequest,
  type CreateTournamentResponse,
  type Tournament,
  type UpdateTournamentDescriptionRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { badRequest } from '../errors';

const MAX_NAME_LENGTH = 80;

export async function createTournament(c: Context) {
  const body = await c.req.json<CreateTournamentRequest>().catch(() => null);
  const name = body?.name?.trim();
  if (!name) throw badRequest('Tournament name is required');
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`Tournament name must be at most ${MAX_NAME_LENGTH} characters`);

  const now = new Date().toISOString();
  const tournament: Tournament = {
    id: uuidv4(),
    name,
    description: '',
    adminToken: uuidv4(),
    createdAt: now,
    teams: [],
    challenges: [],
  };

  await storage.createTournament(tournament);

  const response: CreateTournamentResponse = {
    tournamentId: tournament.id,
    adminToken: tournament.adminToken,
  };
  return c.json(response, 201);
}

export async function getPublicTournament(c: Context) {
  const id = c.req.param('tournamentId')!;
  const tournament = await storage.getTournament(id);
  return c.json(toPublicTournament(tournament));
}

export async function getAdminTournament(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const tournament = await storage.getTournament(id);
  requireAdmin(tournament, token);
  return c.json(toAdminTournamentView(tournament));
}

export async function updateDescription(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateTournamentDescriptionRequest>().catch(() => null);
  const description = body?.description ?? '';
  if (description.length > TOURNAMENT_DESCRIPTION_MAX_LENGTH) {
    throw badRequest(`description must be at most ${TOURNAMENT_DESCRIPTION_MAX_LENGTH} characters`);
  }

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.description = description.trim();
  });

  const tournament = await storage.getTournament(id);
  return c.json(toPublicTournament(tournament));
}
