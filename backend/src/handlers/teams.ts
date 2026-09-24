import type { Context } from 'hono';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import {
  MAX_TEAM_IMPORT_ROWS,
  NAF_NUMBER_PATTERN,
  derivePasswordFromCoachName,
  matchRace,
  type CreateTeamRequest,
  type CreateTeamResponse,
  type ImportTeamsRequest,
  type ImportTeamsResponse,
  type ResolveTeamResponse,
  type RosterStatus,
  type Squad,
  type Team,
  type Tournament,
  type UpdateRosterStatusRequest,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { authenticateTeam, findTeamById, isAdmin, requireAdmin, validatePassword } from '../auth';
import { toAdminTournamentView, toPublicTournament } from '../sanitize';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { assetsBucketName, rosterImageKey } from '../rosterImage';

const s3 = new S3Client({});
const MAX_FIELD_LENGTH = 40;

/** Returns the trimmed NAF number, or null if omitted/blank. Throws 400 if present but malformed. */
function validateNafNumber(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const nafNumber = raw.trim();
  if (!nafNumber) return null;
  if (!NAF_NUMBER_PATTERN.test(nafNumber)) {
    throw badRequest('Le numéro NAF doit être un nombre entier positif', 'invalid_naf_number');
  }
  return nafNumber;
}

function validateTeamInput(body: Partial<CreateTeamRequest> | null): {
  name: string | undefined;
  coachName: string;
  race: string;
  password: string;
  nafNumber: string | null;
} {
  const name = body?.name?.trim() || undefined;
  const coachName = body?.coachName?.trim();
  const race = body?.race?.trim();
  if (!coachName) throw badRequest('Coach name is required');
  if (!race) throw badRequest('Race is required');
  for (const [field, value] of [['name', name], ['coachName', coachName], ['race', race]] as const) {
    if (value && value.length > MAX_FIELD_LENGTH) throw badRequest(`${field} must be at most ${MAX_FIELD_LENGTH} characters`);
  }
  const password = validatePassword(body?.password);
  const nafNumber = validateNafNumber(body?.nafNumber);
  return { name, coachName, race, password, nafNumber };
}

/**
 * In a team-format tournament the coach never enters their own team name (the squad is the
 * meaningful identity) — this derives an internal placeholder from the coach's name, disambiguated
 * if needed, so `Team.name` (still required by the schema/storage) stays populated without
 * prompting for it.
 */
function generateDefaultTeamName(existingTeams: Team[], coachName: string): string {
  const base = coachName.slice(0, MAX_FIELD_LENGTH);
  let candidate = base;
  for (let suffix = 2; existingTeams.some((tm) => tm.name.toLowerCase() === candidate.toLowerCase()); suffix++) {
    candidate = `${base} (${suffix})`.slice(0, MAX_FIELD_LENGTH);
  }
  return candidate;
}

/**
 * Resolves the squadId a new team should join, for 'team' format tournaments only (returns null
 * for 'individual' tournaments, ignoring any squadId/newSquadName the client sent). Must run
 * inside the storage mutator so squad name/size checks see fresh state on optimistic-lock retry.
 */
function resolveSquadForNewTeam(t: Tournament, body: Partial<CreateTeamRequest> | null): string | null {
  if (t.format !== 'team') return null;
  const squadId = body?.squadId?.trim();
  const newSquadName = body?.newSquadName?.trim();
  if (squadId && newSquadName) {
    throw badRequest('Provide either squadId or newSquadName, not both', 'squad_choice_conflict');
  }
  if (squadId) {
    const squad = t.squads.find((s) => s.id === squadId);
    if (!squad) throw notFound('Squad not found');
    const memberCount = t.teams.filter((tm) => tm.squadId === squad.id).length;
    if (t.squadSize !== null && memberCount >= t.squadSize) {
      throw forbidden(`Squad "${squad.name}" is already full`, 'squad_full');
    }
    return squad.id;
  }
  if (newSquadName) {
    if (newSquadName.length > MAX_FIELD_LENGTH) {
      throw badRequest(`Squad name must be at most ${MAX_FIELD_LENGTH} characters`);
    }
    if (t.squads.some((s) => s.name.toLowerCase() === newSquadName.toLowerCase())) {
      throw conflict(`A squad named "${newSquadName}" already exists in this tournament`, 'squad_name_taken');
    }
    const squad: Squad = { id: uuidv4(), name: newSquadName, createdAt: new Date().toISOString() };
    t.squads.push(squad);
    return squad.id;
  }
  throw badRequest('squadId or newSquadName is required to join a team-format tournament', 'squad_required');
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
  const { name: rawName, coachName, race, password, nafNumber } = validateTeamInput(body);

  let newTeamId = '';
  await storage.updateTournament(tournamentId, (t) => {
    if (t.mode !== 'ladder' && t.rounds.length > 0) {
      throw forbidden('Registration is closed once the tournament rounds have started', 'registration_closed');
    }
    if (!rawName && t.format !== 'team') throw badRequest('Team name is required');
    const name = rawName ?? generateDefaultTeamName(t.teams, coachName);
    if (t.teams.some((team) => team.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`A team named "${name}" already exists in this tournament`, 'team_name_taken');
    }
    assertCredentialsFree(t, coachName, password);
    const squadId = resolveSquadForNewTeam(t, body);

    const now = new Date().toISOString();
    const newTeam: Team = {
      id: uuidv4(),
      password,
      name,
      coachName,
      race,
      nafNumber,
      squadId,
      poolId: null,
      createdAt: now,
      rosterImage: null,
      rosterStatus: 'created',
    };
    newTeamId = newTeam.id;
    t.teams.push(newTeam);
  });

  const response: CreateTeamResponse = { teamId: newTeamId };
  return c.json(response, 201);
}

/**
 * Validates and prepares every row of a bulk import against the tournament's CURRENT team list,
 * pure and exported for direct unit testing. Fixed row shape: coachName, race, optional
 * nafNumber — team name is always the coach name (no separate team-name column). Returns every
 * validation error found (not just the first) so the caller can reject the whole batch with a
 * complete picture, and the ready-to-push `Team` objects for when there are none.
 */
export function prepareImportedTeams(
  existingTeams: Team[],
  rows: { coachName?: string; race?: string; nafNumber?: string }[]
): { errors: string[]; teams: Team[] } {
  const now = new Date().toISOString();
  const errors: string[] = [];
  const prepared: Team[] = [];
  const seenCoachNamesInBatch = new Set<string>();
  const seenTeamNamesInBatch = new Set<string>();

  rows.forEach((row, i) => {
    const lineNo = i + 1;
    const coachName = row?.coachName?.trim();
    const rawRace = row?.race?.trim();

    if (!coachName) {
      errors.push(`Ligne ${lineNo} : nom de coach manquant`);
      return;
    }
    if (coachName.length > MAX_FIELD_LENGTH) {
      errors.push(`Ligne ${lineNo} : nom de coach trop long (max ${MAX_FIELD_LENGTH} caractères)`);
      return;
    }
    if (!rawRace) {
      errors.push(`Ligne ${lineNo} : race manquante`);
      return;
    }
    const matched = matchRace(rawRace);
    if (!matched) {
      errors.push(`Ligne ${lineNo} : race "${rawRace}" non reconnue`);
      return;
    }

    let nafNumber: string | null = null;
    const rawNaf = row?.nafNumber?.trim();
    if (rawNaf) {
      if (!NAF_NUMBER_PATTERN.test(rawNaf)) {
        errors.push(`Ligne ${lineNo} : numéro NAF invalide`);
        return;
      }
      nafNumber = rawNaf;
    }

    const name = coachName; // team name = coach name for bulk imports, no separate column
    const lowerCoach = coachName.toLowerCase();
    const lowerName = name.toLowerCase();
    const password = derivePasswordFromCoachName(coachName);

    if (seenCoachNamesInBatch.has(lowerCoach)) {
      errors.push(`Ligne ${lineNo} : coach "${coachName}" en double dans le fichier`);
      return;
    }
    if (existingTeams.some((tm) => tm.coachName.toLowerCase() === lowerCoach && tm.password === password)) {
      errors.push(`Ligne ${lineNo} : coach "${coachName}" déjà inscrit dans ce tournoi`);
      return;
    }
    if (seenTeamNamesInBatch.has(lowerName) || existingTeams.some((tm) => tm.name.toLowerCase() === lowerName)) {
      errors.push(`Ligne ${lineNo} : nom d'équipe "${name}" déjà utilisé`);
      return;
    }

    seenCoachNamesInBatch.add(lowerCoach);
    seenTeamNamesInBatch.add(lowerName);
    prepared.push({
      id: uuidv4(),
      password,
      name,
      coachName,
      race: matched.race,
      nafNumber,
      squadId: null,
      poolId: null,
      createdAt: now,
      rosterImage: null,
      rosterStatus: 'created',
    });
  });

  return { errors, teams: prepared };
}

/**
 * Admin bulk import (CSV pasted client-side, parsed/fuzzy-matched there — see
 * frontend's team-import component). All rows are validated up front (see
 * `prepareImportedTeams`); if any row fails, nothing is created (storage.updateTournament only
 * persists if the mutator returns without throwing) — the admin fixes the flagged rows and
 * resubmits, rather than ending up with a partially-imported roster.
 */
export async function importTeams(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<ImportTeamsRequest>().catch(() => null);
  const rows = body?.rows;
  if (!Array.isArray(rows) || rows.length === 0) throw badRequest('rows must be a non-empty array');
  if (rows.length > MAX_TEAM_IMPORT_ROWS) {
    throw badRequest(`Cannot import more than ${MAX_TEAM_IMPORT_ROWS} teams at once`);
  }

  let teamIds: string[] = [];
  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.mode !== 'ladder' && t.rounds.length > 0) {
      throw forbidden('Registration is closed once the tournament rounds have started', 'registration_closed');
    }

    const { errors, teams: prepared } = prepareImportedTeams(t.teams, rows);
    if (errors.length > 0) throw badRequest(errors.join('\n'), 'import_validation_failed');

    t.teams.push(...prepared);
    teamIds = prepared.map((tm) => tm.id);
  });

  const response: ImportTeamsResponse = { teamIds };
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
      if (!admin && t.format === 'team') {
        throw forbidden('Team name cannot be changed in a team-format tournament', 'team_name_locked');
      }
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
      if (!admin && t.requireRosterValidation && team.rosterStatus === 'validated') {
        throw forbidden('Race cannot be changed once the roster has been validated', 'race_locked');
      }
      const race = body.race.trim();
      if (!race) throw badRequest('Race is required');
      team.race = race;
    }
    if (body.password !== undefined) {
      team.password = validatePassword(body.password);
    }
    if (body.nafNumber !== undefined) {
      team.nafNumber = validateNafNumber(body.nafNumber);
    }
    if (body.coachName !== undefined || body.password !== undefined) {
      assertCredentialsFree(t, team.coachName, team.password, teamId);
    }
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, teamId));
}

export async function deleteTeam(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdminOrThrow(t, token);
    const team = t.teams.find((tm) => tm.id === teamId);
    if (!team) throw notFound('Team not found');
    const hasNonDeclinedChallenges = t.challenges.some(
      (ch) => (ch.team1Id === teamId || ch.team2Id === teamId) && ch.status !== 'declined'
    );
    if (hasNonDeclinedChallenges) {
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

const VALID_STATUSES: RosterStatus[] = ['created', 'submitted', 'validated'];

export async function updateRosterStatus(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const password = c.req.query('password');
  const token = c.req.query('token');
  const body = await c.req.json<UpdateRosterStatusRequest>().catch(() => null);
  const status = body?.status;
  if (!status || !VALID_STATUSES.includes(status)) {
    throw badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  await storage.updateTournament(tournamentId, (t) => {
    if (!t.requireRosterValidation) {
      throw forbidden('Roster validation is not enabled for this tournament', 'roster_validation_disabled');
    }
    const team = findTeamById(t, teamId);
    const admin = isAdmin(t, token);

    if (admin) {
      if (status !== 'validated' && status !== 'created') {
        throw forbidden('The admin can only validate a roster or reset it, not mark it as submitted');
      }
      team.rosterStatus = status;
      return;
    }

    authenticateTeam(t, teamId, password);
    if (status !== 'submitted') {
      throw forbidden('A coach can only submit their roster for validation');
    }
    if (team.rosterStatus !== 'created') {
      throw forbidden(`Cannot submit for validation from status: ${team.rosterStatus}`);
    }
    if (!team.rosterImage) {
      throw badRequest('Upload a roster image before submitting it for validation', 'roster_image_required');
    }
    team.rosterStatus = 'submitted';
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toPublicTournament(tournament, teamId));
}
