import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  ALL_SQUAD_TIEBREAKER_CRITERIA,
  DEFAULT_SQUAD_SCORING,
  resolveSquadScoring,
  type AssignTeamSquadRequest,
  type CreateSquadRequest,
  type Squad,
  type SquadScoringConfig,
  type UpdateSquadRequest,
  type UpdateSquadScoringRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { findTeamById, requireAdmin } from '../auth';
import { toAdminTournamentView } from '../sanitize';
import { badRequest, conflict, forbidden, notFound } from '../errors';

const MAX_SQUAD_NAME_LENGTH = 40;

function validateSquadName(raw: string | undefined | null): string {
  const name = raw?.trim();
  if (!name) throw badRequest('Squad name is required');
  if (name.length > MAX_SQUAD_NAME_LENGTH) {
    throw badRequest(`Squad name must be at most ${MAX_SQUAD_NAME_LENGTH} characters`);
  }
  return name;
}

function assertSquadNameFree(squads: Squad[], name: string, excludeSquadId?: string): void {
  const clash = squads.some((s) => s.id !== excludeSquadId && s.name.toLowerCase() === name.toLowerCase());
  if (clash) throw conflict(`A squad named "${name}" already exists in this tournament`, 'squad_name_taken');
}

const SCORING_NUMBER_FIELDS = ['pointsWin', 'pointsDraw', 'pointsLoss', 'pointsBigWin', 'pointsSmallLoss'] as const;

const OUTCOME_KEY = /^(\d+)-(\d+)-(\d+)$/;

/** Validates a list of "W-D-L" board records, all on the expected side (win: W > L, loss: W < L). */
function validateOutcomes(raw: unknown, field: string, side: 'win' | 'loss'): string[] {
  if (!Array.isArray(raw)) throw badRequest(`${field} must be an array`, 'invalid_squad_scoring');
  const keys = new Set<string>();
  for (const value of raw) {
    const m = typeof value === 'string' ? OUTCOME_KEY.exec(value) : null;
    if (!m) throw badRequest(`${field} entries must look like "W-D-L"`, 'invalid_squad_scoring');
    const wins = Number(m[1]);
    const losses = Number(m[3]);
    if (side === 'win' ? wins <= losses : wins >= losses) {
      throw badRequest(`${field}: "${value}" is not a ${side}`, 'invalid_squad_scoring');
    }
    keys.add(`${wins}-${Number(m[2])}-${losses}`);
  }
  return Array.from(keys);
}

/** Merges a partial scoring override onto a base config, validating every field it touches. */
export function mergeSquadScoring(
  base: Partial<SquadScoringConfig>,
  partial: Partial<SquadScoringConfig> | null | undefined
): SquadScoringConfig {
  for (const field of ['tiebreakers', 'bigWinOutcomes', 'smallLossOutcomes'] as const) {
    if (partial?.[field] !== undefined && !Array.isArray(partial[field])) {
      throw badRequest(`${field} must be an array`, 'invalid_squad_scoring');
    }
  }
  const merged = resolveSquadScoring({ ...resolveSquadScoring(base), ...(partial ?? {}) });

  const { tiebreakers } = merged;
  if (
    tiebreakers.some((c) => !ALL_SQUAD_TIEBREAKER_CRITERIA.includes(c)) ||
    new Set(tiebreakers).size !== tiebreakers.length
  ) {
    throw badRequest('tiebreakers must be a list of distinct squad tiebreaker criteria', 'invalid_squad_scoring');
  }

  if (typeof merged.bonusTiers !== 'boolean') {
    throw badRequest('bonusTiers must be a boolean', 'invalid_squad_scoring');
  }
  merged.bigWinOutcomes = validateOutcomes(merged.bigWinOutcomes, 'bigWinOutcomes', 'win');
  merged.smallLossOutcomes = validateOutcomes(merged.smallLossOutcomes, 'smallLossOutcomes', 'loss');
  for (const field of SCORING_NUMBER_FIELDS) {
    const value = merged[field];
    if (!Number.isInteger(value) || value < 0) {
      throw badRequest(`${field} must be a non-negative integer`, 'invalid_squad_scoring');
    }
  }
  return merged;
}

export async function createSquad(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<CreateSquadRequest>().catch(() => null);
  const name = validateSquadName(body?.name);

  const now = new Date().toISOString();
  const squad: Squad = { id: uuidv4(), name, createdAt: now };

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.format !== 'team') throw forbidden('This tournament is not in team format', 'not_team_format');
    assertSquadNameFree(t.squads, name);
    t.squads.push(squad);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament), 201);
}

export async function renameSquad(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const squadId = c.req.param('squadId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateSquadRequest>().catch(() => null);
  const name = validateSquadName(body?.name);

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.format !== 'team') throw forbidden('This tournament is not in team format', 'not_team_format');
    const squad = t.squads.find((s) => s.id === squadId);
    if (!squad) throw notFound('Squad not found');
    assertSquadNameFree(t.squads, name, squadId);
    squad.name = name;
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

export async function deleteSquad(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const squadId = c.req.param('squadId')!;
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.format !== 'team') throw forbidden('This tournament is not in team format', 'not_team_format');
    const squad = t.squads.find((s) => s.id === squadId);
    if (!squad) throw notFound('Squad not found');
    if (t.teams.some((tm) => tm.squadId === squadId)) {
      throw forbidden('Cannot delete a squad that still has members; reassign them first', 'squad_not_empty');
    }
    t.squads = t.squads.filter((s) => s.id !== squadId);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

export async function assignTeamSquad(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const token = c.req.query('token');
  const body = await c.req.json<AssignTeamSquadRequest>().catch(() => null);

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.format !== 'team') throw forbidden('This tournament is not in team format', 'not_team_format');
    const team = findTeamById(t, teamId);
    if (body?.squadId) {
      const squad = t.squads.find((s) => s.id === body.squadId);
      if (!squad) throw notFound('Squad not found');
      const memberCount = t.teams.filter((tm) => tm.squadId === squad.id).length;
      if (team.squadId !== squad.id && t.squadSize !== null && memberCount >= t.squadSize) {
        throw forbidden(`Squad "${squad.name}" is already full`, 'squad_full');
      }
      team.squadId = squad.id;
    } else {
      team.squadId = null;
    }
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

export async function updateSquadScoring(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateSquadScoringRequest>().catch(() => null);

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.format !== 'team') throw forbidden('This tournament is not in team format', 'not_team_format');
    t.squadScoring = mergeSquadScoring(t.squadScoring ?? DEFAULT_SQUAD_SCORING, body);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}
