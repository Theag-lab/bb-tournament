import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  ALL_TIEBREAKER_CRITERIA,
  CUSTOM_STAT_NAME_MAX_LENGTH,
  CUSTOM_STAT_PRECISION_MAX_LENGTH,
  DEFAULT_INDIVIDUAL_SCORING,
  DEFAULT_MATCH_SHEET_CONFIG,
  DEFAULT_ROUND_TIMER,
  DEFAULT_SQUAD_SCORING,
  MAX_CUSTOM_STAT_CATEGORIES,
  MAX_POOL_SIZE,
  MAX_QUALIFIERS_PER_POOL,
  MAX_ROUND_COUNT,
  MAX_ROUND_TIMER_SECONDS,
  MAX_SCORING_MULTIPLIER,
  MAX_SCORING_POINTS,
  MAX_SQUAD_SIZE,
  MIN_POOL_SIZE,
  MIN_QUALIFIERS_PER_POOL,
  MIN_ROUND_COUNT,
  MIN_ROUND_TIMER_SECONDS,
  MIN_SCORING_MULTIPLIER,
  MIN_SCORING_POINTS,
  MIN_SQUAD_SIZE,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  TOURNAMENT_DESCRIPTION_MAX_LENGTH,
  TOURNAMENT_ID_MAX_LENGTH,
  TOURNAMENT_ID_MIN_LENGTH,
  TOURNAMENT_ID_PATTERN,
  customTiebreakerCategoryId,
  customTiebreakerCriterion,
  recomputeMatchPoints,
  type CreateTournamentRequest,
  type CreateTournamentResponse,
  type CustomStatCategoryConfig,
  type CustomStatCategoryInput,
  type IndividualScoringConfig,
  type IndividualScoringMode,
  type MatchSheetConfig,
  type MatchSheetFieldConfig,
  type RawPointsComponent,
  type RawPointsStatBasis,
  type RoundTimerState,
  type TiebreakerCriterion,
  type Tournament,
  type TournamentFormat,
  type TournamentMode,
  type UpdateCustomStatCategoriesRequest,
  type UpdateIndividualScoringRequest,
  type UpdateMatchSheetConfigRequest,
  type UpdateRoundTimerRequest,
  type UpdateTournamentDescriptionRequest,
  type UpdateDisplaySettingsRequest,
  type UpdateResultValidationSettingsRequest,
  type UpdateTournamentOrganizerRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { mergeSquadScoring } from './squads';
import { AppError, badRequest, conflict } from '../errors';

const MAX_NAME_LENGTH = 80;
const VALID_MODES: TournamentMode[] = ['ladder', 'swiss', 'swiss_with_challenge', 'pools_knockout'];
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

/**
 * `customStatCategoryIds` is the tournament's *current* custom stat category ids — a `custom:${id}`
 * criterion is only valid while that category still exists, so deleting a category also
 * invalidates any tiebreaker entry referencing it (the admin would need to remove it from the list
 * before saving, same as any other now-invalid input).
 */
function validateTiebreakers(value: unknown, customStatCategoryIds: string[]): TiebreakerCriterion[] {
  if (!Array.isArray(value)) {
    throw badRequest('tiebreakers must be an array', 'invalid_individual_scoring');
  }
  const validCustomCriteria = new Set(customStatCategoryIds.map((id) => customTiebreakerCriterion(id)));
  for (const item of value) {
    if (!ALL_TIEBREAKER_CRITERIA.includes(item) && !validCustomCriteria.has(item)) {
      throw badRequest(`Invalid tiebreaker criterion: ${item}`, 'invalid_individual_scoring');
    }
  }
  return value as TiebreakerCriterion[];
}

/**
 * Merges a partial scoring override onto a base config, validating every field it touches.
 * `customStatCategoryIds` (the tournament's current custom stat categories) is only needed to
 * validate any `custom:${id}` tiebreaker entries in `partial.tiebreakers` — omit it (defaults to
 * none) wherever the tournament has no custom stat categories, e.g. in tests.
 */
export function mergeIndividualScoring(
  base: IndividualScoringConfig,
  partial: Partial<IndividualScoringConfig> | null | undefined,
  customStatCategoryIds: string[] = []
): IndividualScoringConfig {
  const merged: IndividualScoringConfig = { ...base, ...(partial ?? {}) };

  if (!VALID_SCORING_MODES.includes(merged.mode)) {
    throw badRequest(`mode must be one of: ${VALID_SCORING_MODES.join(', ')}`, 'invalid_individual_scoring');
  }
  validateScoringPoints(merged.pointsWin, 'pointsWin');
  validateScoringPoints(merged.pointsDraw, 'pointsDraw');
  validateScoringPoints(merged.pointsLoss, 'pointsLoss');
  validateScoringPoints(merged.pointsConcessionPenalty, 'pointsConcessionPenalty');
  merged.tiebreakers = validateTiebreakers(merged.tiebreakers, customStatCategoryIds);
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
      t.individualScoring,
      t.customStatCategories ?? []
    );
    challenge.result.team1Points = team1Points;
    challenge.result.team2Points = team2Points;
  }
}

export interface PoolsKnockoutConfig {
  poolSize: number | null;
  poolRoundCount: number | null;
  qualifiersPerPool: number | null;
}

/**
 * Validates and resolves the pools_knockout-specific creation fields. Returns all-null for any
 * other mode (these fields stay null on the Tournament in that case — see createTournament).
 */
export function resolvePoolsKnockoutConfig(
  mode: TournamentMode,
  body: Pick<CreateTournamentRequest, 'poolSize' | 'poolRoundCount' | 'qualifiersPerPool'> | null | undefined
): PoolsKnockoutConfig {
  if (mode !== 'pools_knockout') return { poolSize: null, poolRoundCount: null, qualifiersPerPool: null };

  const size = body?.poolSize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < MIN_POOL_SIZE || size > MAX_POOL_SIZE) {
    throw badRequest(`poolSize must be an integer between ${MIN_POOL_SIZE} and ${MAX_POOL_SIZE}`);
  }

  const prc = body?.poolRoundCount;
  if (typeof prc !== 'number' || !Number.isInteger(prc) || prc < MIN_ROUND_COUNT || prc > MAX_ROUND_COUNT) {
    throw badRequest(`poolRoundCount must be an integer between ${MIN_ROUND_COUNT} and ${MAX_ROUND_COUNT}`);
  }

  const qpp = body?.qualifiersPerPool;
  if (
    typeof qpp !== 'number' ||
    !Number.isInteger(qpp) ||
    qpp < MIN_QUALIFIERS_PER_POOL ||
    qpp > MAX_QUALIFIERS_PER_POOL
  ) {
    throw badRequest(`qualifiersPerPool must be an integer between ${MIN_QUALIFIERS_PER_POOL} and ${MAX_QUALIFIERS_PER_POOL}`);
  }
  if (qpp >= size) {
    throw badRequest('qualifiersPerPool must be smaller than poolSize');
  }

  return { poolSize: size, poolRoundCount: prc, qualifiersPerPool: qpp };
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

  // v1 scope: pools_knockout only combines with the 'individual' format, same as the other
  // non-ladder modes were introduced format-agnostic but team-format tournaments force 'swiss'
  // above — pools_knockout simply isn't offered as a team-format choice.
  if (mode === 'pools_knockout' && format === 'team') {
    throw badRequest("Le mode poules puis élimination directe n'est pas compatible avec le format équipe");
  }

  let roundCount: number | null = null;
  if (mode !== 'ladder' && mode !== 'pools_knockout') {
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

  const { poolSize, poolRoundCount, qualifiersPerPool } = resolvePoolsKnockoutConfig(mode, body);

  const now = new Date().toISOString();
  const tournament: Tournament = {
    id,
    name,
    description: '',
    organizerCoachName,
    requireRosterValidation: body?.requireRosterValidation === true,
    requireResultConfirmation: body?.requireResultConfirmation !== false,
    showTeamNames: true,
    mode,
    roundCount,
    rounds: [],
    format,
    squadSize,
    squadScoring: format === 'team' ? mergeSquadScoring(DEFAULT_SQUAD_SCORING, body?.squadScoring) : null,
    squads: [],
    poolSize,
    poolRoundCount,
    qualifiersPerPool,
    pools: [],
    knockoutSeeds: null,
    individualScoring: mergeIndividualScoring(DEFAULT_INDIVIDUAL_SCORING, body?.individualScoring),
    matchSheetConfig: DEFAULT_MATCH_SHEET_CONFIG,
    customStatCategories: [],
    roundTimer: DEFAULT_ROUND_TIMER,
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

export async function updateDisplaySettings(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateDisplaySettingsRequest>().catch(() => null);
  if (typeof body?.showTeamNames !== 'boolean') throw badRequest('showTeamNames must be a boolean');

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.showTeamNames = body.showTeamNames;
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}

export async function updateResultValidationSettings(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateResultValidationSettingsRequest>().catch(() => null);
  if (typeof body?.requireResultConfirmation !== 'boolean') {
    throw badRequest('requireResultConfirmation must be a boolean');
  }

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.requireResultConfirmation = body.requireResultConfirmation;
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}

/**
 * Pure transition function for the round-timer PATCH: validates the request and returns the next
 * `RoundTimerState` from the current one. `now` is injectable for testability.
 */
export function computeNextRoundTimer(
  current: RoundTimerState,
  request: UpdateRoundTimerRequest | null,
  now: () => string = () => new Date().toISOString()
): RoundTimerState {
  if (request?.start && request?.reset) {
    throw badRequest('start and reset cannot both be set', 'invalid_round_timer');
  }

  let durationSeconds = current.durationSeconds;
  if (request?.durationSeconds !== undefined) {
    const d = request.durationSeconds;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < MIN_ROUND_TIMER_SECONDS || d > MAX_ROUND_TIMER_SECONDS) {
      throw badRequest(
        `durationSeconds must be an integer between ${MIN_ROUND_TIMER_SECONDS} and ${MAX_ROUND_TIMER_SECONDS}`,
        'invalid_round_timer'
      );
    }
    durationSeconds = d;
  }

  let startedAt = current.startedAt;
  if (request?.reset) startedAt = null;
  if (request?.start) startedAt = now();

  return { durationSeconds, startedAt };
}

export async function updateRoundTimer(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateRoundTimerRequest>().catch(() => null);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.roundTimer = computeNextRoundTimer(t.roundTimer ?? DEFAULT_ROUND_TIMER, body);
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}

export async function updateIndividualScoring(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateIndividualScoringRequest>().catch(() => null);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    const customStatCategoryIds = (t.customStatCategories ?? []).map((c) => c.id);
    t.individualScoring = mergeIndividualScoring(t.individualScoring ?? DEFAULT_INDIVIDUAL_SCORING, body, customStatCategoryIds);
    recomputeAllMatchPoints(t);
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}

/** Validates one built-in match-sheet field's partial update (precision length, enabled type). */
function mergeMatchSheetFieldConfig(
  base: MatchSheetFieldConfig,
  partial: Partial<MatchSheetFieldConfig> | undefined,
  field: string
): MatchSheetFieldConfig {
  const merged = { ...base, ...(partial ?? {}) };
  if (typeof merged.enabled !== 'boolean') {
    throw badRequest(`${field}.enabled must be a boolean`, 'invalid_match_sheet_config');
  }
  if (typeof merged.precision !== 'string' || merged.precision.length > CUSTOM_STAT_PRECISION_MAX_LENGTH) {
    throw badRequest(
      `${field}.precision must be a string of at most ${CUSTOM_STAT_PRECISION_MAX_LENGTH} characters`,
      'invalid_match_sheet_config'
    );
  }
  return merged;
}

export function mergeMatchSheetConfig(
  base: MatchSheetConfig,
  partial: UpdateMatchSheetConfigRequest | null | undefined
): MatchSheetConfig {
  const tdPrecision = partial?.td?.precision ?? base.td.precision;
  if (typeof tdPrecision !== 'string' || tdPrecision.length > CUSTOM_STAT_PRECISION_MAX_LENGTH) {
    throw badRequest(`td.precision must be a string of at most ${CUSTOM_STAT_PRECISION_MAX_LENGTH} characters`, 'invalid_match_sheet_config');
  }
  return {
    td: { precision: tdPrecision },
    cas: mergeMatchSheetFieldConfig(base.cas, partial?.cas, 'cas'),
    agg: mergeMatchSheetFieldConfig(base.agg, partial?.agg, 'agg'),
  };
}

export async function updateMatchSheetConfig(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateMatchSheetConfigRequest>().catch(() => null);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.matchSheetConfig = mergeMatchSheetConfig(t.matchSheetConfig ?? DEFAULT_MATCH_SHEET_CONFIG, body);
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}

function validateCustomStatCategoryInput(input: unknown, existingIds: Set<string>): CustomStatCategoryConfig {
  if (!input || typeof input !== 'object') {
    throw badRequest('Each custom stat category must be an object', 'invalid_custom_stat_categories');
  }
  const { id, name, precision, enabled, rawPoints } = input as Partial<CustomStatCategoryInput>;

  if (id !== undefined && (typeof id !== 'string' || !existingIds.has(id))) {
    throw badRequest(`Unknown custom stat category id: ${id}`, 'invalid_custom_stat_categories');
  }
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > CUSTOM_STAT_NAME_MAX_LENGTH) {
    throw badRequest(
      `Each custom stat category needs a name of 1-${CUSTOM_STAT_NAME_MAX_LENGTH} characters`,
      'invalid_custom_stat_categories'
    );
  }
  if (typeof precision !== 'string' || precision.length > CUSTOM_STAT_PRECISION_MAX_LENGTH) {
    throw badRequest(
      `Each custom stat category's precision must be a string of at most ${CUSTOM_STAT_PRECISION_MAX_LENGTH} characters`,
      'invalid_custom_stat_categories'
    );
  }
  if (typeof enabled !== 'boolean') {
    throw badRequest('Each custom stat category needs an enabled boolean', 'invalid_custom_stat_categories');
  }

  return {
    id: id ?? uuidv4(),
    name: trimmedName,
    precision,
    enabled,
    rawPoints: validateRawPointsComponent(rawPoints, 'rawPoints'),
  };
}

/**
 * Whole-list replace: validates and returns the full new category list. Existing ids referenced in
 * `body.categories` must belong to `existing` (an admin can't just make up an id to overwrite
 * someone else's category); ids omitted from the new list are simply dropped (their historical
 * match data stays in old MatchResult.customStats entries, just no longer surfaced anywhere).
 */
export function mergeCustomStatCategories(
  existing: CustomStatCategoryConfig[],
  body: UpdateCustomStatCategoriesRequest | null | undefined
): CustomStatCategoryConfig[] {
  const categories = body?.categories;
  if (!Array.isArray(categories)) {
    throw badRequest('categories must be an array', 'invalid_custom_stat_categories');
  }
  if (categories.length > MAX_CUSTOM_STAT_CATEGORIES) {
    throw badRequest(`At most ${MAX_CUSTOM_STAT_CATEGORIES} custom stat categories are allowed`, 'invalid_custom_stat_categories');
  }
  const existingIds = new Set(existing.map((c) => c.id));
  const resolved = categories.map((input) => validateCustomStatCategoryInput(input, existingIds));

  const names = new Set<string>();
  for (const category of resolved) {
    const key = category.name.toLowerCase();
    if (names.has(key)) {
      throw badRequest(`Duplicate custom stat category name: ${category.name}`, 'invalid_custom_stat_categories');
    }
    names.add(key);
  }

  return resolved;
}

export async function updateCustomStatCategories(c: Context) {
  const id = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<UpdateCustomStatCategoriesRequest>().catch(() => null);

  await storage.updateTournament(id, (t) => {
    requireAdmin(t, token);
    t.customStatCategories = mergeCustomStatCategories(t.customStatCategories ?? [], body);

    // A category that just got disabled (or removed) can't stay referenced by a tiebreaker, or it
    // would silently compare as "always tied" — drop those entries the same way a deleted category
    // already invalidates its tiebreaker (see validateTiebreakers).
    const stillUsable = new Set(t.customStatCategories.filter((c) => c.enabled).map((c) => c.id));
    t.individualScoring.tiebreakers = t.individualScoring.tiebreakers.filter((criterion) => {
      const categoryId = customTiebreakerCategoryId(criterion);
      return categoryId === null || stillUsable.has(categoryId);
    });

    recomputeAllMatchPoints(t);
  });

  const tournament = await storage.getTournament(id);
  return c.json(toAdminTournamentView(tournament));
}
