import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_SQUAD_SCORING,
  MAX_ROUND_COUNT,
  MAX_SQUAD_SIZE,
  MIN_ROUND_COUNT,
  MIN_SQUAD_SIZE,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  type CreateTournamentRequest,
  type CreateTournamentResponse,
  type Tournament,
  type TournamentFormat,
  type TournamentMode,
  type UpdateTournamentDescriptionRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { mergeSquadScoring } from './squads';
import { badRequest } from '../errors';

const MAX_NAME_LENGTH = 80;
const VALID_MODES: TournamentMode[] = ['ladder', 'swiss', 'swiss_with_challenge'];
const VALID_FORMATS: TournamentFormat[] = ['individual', 'team'];

export async function createTournament(c: Context) {
  const body = await c.req.json<CreateTournamentRequest>().catch(() => null);
  const name = body?.name?.trim();
  if (!name) throw badRequest('Tournament name is required');
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`Tournament name must be at most ${MAX_NAME_LENGTH} characters`);

  const format: TournamentFormat = body?.format && VALID_FORMATS.includes(body.format) ? body.format : 'individual';

  // A 'team' tournament is always paired via swiss rounds, with no free challenges (see
  // canCreateFreeChallenge in handlers/challenges.ts, which already returns false for 'swiss').
  const mode: TournamentMode =
    format === 'team' ? 'swiss' : body?.mode && VALID_MODES.includes(body.mode) ? body.mode : 'ladder';

  let roundCount: number | null = null;
  if (mode !== 'ladder') {
    const rc = body?.roundCount;
    if (typeof rc !== 'number' || !Number.isInteger(rc) || rc < MIN_ROUND_COUNT || rc > MAX_ROUND_COUNT) {
      throw badRequest(`roundCount must be an integer between ${MIN_ROUND_COUNT} and ${MAX_ROUND_COUNT} for this mode`);
    }
    roundCount = rc;
  }

  let squadSize: number | null = null;
  if (format === 'team') {
    const size = body?.squadSize;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < MIN_SQUAD_SIZE || size > MAX_SQUAD_SIZE) {
      throw badRequest(`squadSize must be an integer between ${MIN_SQUAD_SIZE} and ${MAX_SQUAD_SIZE} for team format`);
    }
    squadSize = size;
  }

  const now = new Date().toISOString();
  const tournament: Tournament = {
    id: uuidv4(),
    name,
    description: '',
    requireRosterValidation: body?.requireRosterValidation === true,
    mode,
    roundCount,
    rounds: [],
    format,
    squadSize,
    squadScoring: format === 'team' ? mergeSquadScoring(DEFAULT_SQUAD_SCORING, body?.squadScoring) : null,
    squads: [],
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
  const viewerTeamId = c.req.query('viewerTeamId');
  const viewerPassword = c.req.query('viewerPassword');
  const tournament = await storage.getTournament(id);

  let viewer: string | null = null;
  if (viewerTeamId && viewerPassword) {
    const team = tournament.teams.find((t) => t.id === viewerTeamId);
    if (team && team.password === viewerPassword) viewer = team.id;
  }

  return c.json(toPublicTournament(tournament, viewer));
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
