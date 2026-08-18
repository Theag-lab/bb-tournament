import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { CreateTournamentRequest, CreateTournamentResponse, Tournament } from '@bb-tournament/shared';
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
