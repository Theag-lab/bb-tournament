import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  ALL_TIEBREAKER_CRITERIA,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_SQUAD_SCORING,
  MAX_ROUND_COUNT,
  MAX_SCORING_MULTIPLIER,
  MAX_SCORING_POINTS,
  MAX_SQUAD_SIZE,
  MIN_ROUND_COUNT,
  MIN_SCORING_MULTIPLIER,
  MIN_SCORING_POINTS,
  MIN_SQUAD_SIZE,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  TOURNAMENT_ID_MAX_LENGTH,
  TOURNAMENT_ID_MIN_LENGTH,
  TOURNAMENT_ID_PATTERN,
  recomputeMatchPoints,
  type CreateTournamentRequest,
  type CreateTournamentResponse,
  type IndividualScoringConfig,
  type IndividualScoringMode,
  type RawPointsComponent,
  type RawPointsStatBasis,
  type TiebreakerCriterion,
  type Tournament,
  type TournamentFormat,
  type TournamentMode,
  type UpdateIndividualScoringRequest,
  type UpdateTournamentDescriptionRequest,
  type UpdateTournamentOrganizerRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { mergeSquadScoring } from './squads';
import { AppError, badRequest, conflict } from '../errors';

const MAX_NAME_LENGTH = 80;
const VALID_MODES: TournamentMode[] = ['ladder', 'swiss', 'swiss_with_challenge'];
const VALID_FORMATS: TournamentFormat[] = ['individual', 'team'];
const VALID_SCORING_MODES: IndividualScoringMode[] = ['points_tiebreaker', 'raw_points'];
const VALID_STAT_BASES: RawPointsStatBasis[] = ['total', 'diff'];

function validateScoringPoints(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_SCORING_POINTS || value > MAX_SCORING_POINTS) {
    throw badRequest(`${field} must be an integer between ${MIN_SCORING_POINTS} and ${MAX_SCORING_POINTS}`, 'invalid_individual_scoring');
  }
  return value;
}

function validateRawPointsComponent(value: unknown, field: string): RawPointsComponent {
  if (!value || typeof value !== 'object') {
    throw badRequest(`${field} must be an object with basis and multiplier`, 'invalid_individual_scoring');
  }
  const { basis, multiplier } = value as Partial<RawPointsComponent>;
  if (!basis || !VALID_STAT_BASES.includes(basis)) {
    throw badRequest(`${field}.basis must be one of: ${VALID_STAT_BASES.join(', ')}`, 'invalid_individual_scoring');
  }
  if (
    typeof multiplier !== 'number' ||
    !Number.isInteger(multiplier) ||
    multiplier < MIN_SCORING_MULTIPLIER ||
    multiplier > MAX_SCORING_MULTIPLIER
  ) {
    throw badRequest(
      `${field}.multiplier must be an integer between ${MIN_SCORING_MULTIPLIER} and ${MAX_SCORING_MULTIPLIER}`,
      'invalid_individual_scoring'
    );
  }
  return { basis, multiplier };
}

function validateTiebreakers(value: unknown): TiebreakerCriterion[] {
  if (!Array.isArray(value)) {
    throw badRequest('tiebreakers must be an array', 'invalid_individual_scoring');
  }
  for (const item of value) {
    if (!ALL_TIEBREAKER_CRITERIA.includes(item)) {
      throw badRequest(`Invalid tiebreaker criterion: ${item}`, 'invalid_individual_scoring');
    }
  }
  return value as TiebreakerCriterion[];
}

/** Merges a partial scoring override onto a base config, validating every field it touches. */
export function mergeIndividualScoring(
  base: IndividualScoringConfig,
  partial: Partial<IndividualScoringConfig> | null | undefined
): IndividualScoringConfig {
  const merged: IndividualScoringConfig = { ...base, ...(partial ?? {}) };

  if (!VALID_SCORING_MODES.includes(merged.mode)) {
    throw badRequest(`mode must be one of: ${VALID_SCORING_MODES.join(', ')}`, 'invalid_individual_scoring');
  }
  validateScoringPoints(merged.pointsWin, 'pointsWin');
  validateScoringPoints(merged.pointsDraw, 'pointsDraw');
  validateScoringPoints(merged.pointsLoss, 'pointsLoss');
  validateScoringPoints(merged.pointsConcessionPenalty, 'pointsConcessionPenalty');
  merged.tiebreakers = validateTiebreakers(merged.tiebreakers);
  merged.td = validateRawPointsComponent(merged.td, 'td');
  merged.cas = validateRawPointsComponent(merged.cas, 'cas');
  merged.agg = validateRawPointsComponent(merged.agg, 'agg');

  return merged;
}

/**
 * Refreshes every completed/awaiting-confirmation match's stored points from its raw stats, per
 * the tournament's current individualScoring config — so an admin changing the config immediately
 * re-ranks already-played matches instead of leaving them frozen at whatever config was active
 * when they were submitted.
 */
function recomputeAllMatchPoints(t: Tournament): void {
  for (const challenge of t.challenges) {
    if (!challenge.result) continue;
    const { team1Points, team2Points } = recomputeMatchPoints(
      challenge.result,
      challenge.team1Id,
      challenge.team2Id,
      t.individualScoring
    );
    challenge.result.team1Points = team1Points;
    challenge.result.team2Points = team2Points;
  }
}

export function validateOrganizerCoachName(raw: string | undefined | null): string {
  const name = raw?.trim();
  if (!name) throw badRequest('organizerCoachName is required');
  if (name.length > ORGANIZER_COACH_NAME_MAX_LENGTH) {
    throw badRequest(`organizerCoachName must be at most ${ORGANIZER_COACH_NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export async function createTournament(c: Context) {
  const body = await c.req.json<CreateTournamentRequest>().catch(() => null);
  const name = body?.name?.trim();
  if (!name) throw badRequest('Tournament name is required');
  if (name.length > MAX_NAME_LENGTH) throw badRequest(`Tournament name must be at most ${MAX_NAME_LENGTH} characters`);
  const organizerCoachName = validateOrganizerCoachName(body?.organizerCoachName);

  const rawId = body?.id?.trim();
  if (rawId) {
    if (rawId.length < TOURNAMENT_ID_MIN_LENGTH || rawId.length > TOURNAMENT_ID_MAX_LENGTH) {
      throw badRequest(
        `Tournament id must be between ${TOURNAMENT_ID_MIN_LENGTH} and ${TOURNAMENT_ID_MAX_LENGTH} characters`,
        'invalid_tournament_id'
      );
    }
    if (!TOURNAMENT_ID_PATTERN.test(rawId)) {
      throw badRequest(
        'Tournament id can only contain lowercase letters, digits, and single hyphens between them',
        'invalid_tournament_id'
      );
    }
  }
  const id = rawId || uuidv4();

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
    id,
    name,
    description: '',
    organizerCoachName,
    requireRosterValidation: body?.requireRosterValidation === true,
    mode,
    roundCount,
    rounds: [],
    format,
    squadSize,
    squadScoring: format === 'team' ? mergeSquadScoring(DEFAULT_SQUAD_SCORING, body?.squadScoring) : null,
    squads: [],
    individualScoring: mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, body?.individualScoring),
    adminToken: uuidv4(),
    createdAt: now,
    teams: [],
    challenges: [],
  };

  try {
    await storage.createTournament(tournament);
  } catch (err) {
    if (rawId && err instanceof AppError && err.code === 'id_collision') {
      throw conflict(`L'identifiant "${rawId}" est déjà utilisé par un autre tournoi`, 'tournament_id_taken');
    }
    throw err;
  }

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

export async function updateOrganizer(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateTournamentOrganizerRequest>().catch(() => null);
  const organizerCoachName = validateOrganizerCoachName(body?.organizerCoachName);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.organizerCoachName = organizerCoachName;
  });

  const tournament = await storage.getTournament(id);
  return c.json(toPublicTournament(tournament));
}

export async function updateIndividualScoring(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateIndividualScoringRequest>().catch(() => null);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.individualScoring = mergeIndividualScoring(t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, body);
    recomputeAllMatchPoints(t);
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}
