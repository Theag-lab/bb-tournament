import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  activeCoaches,
  derivePasswordFromCoachName,
  type CreateReplacementRequest,
  type Replacement,
  type Team,
  type Tournament,
} from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView } from '../sanitize';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { generateDefaultTeamName, validateNafNumber } from './teams';

const MAX_FIELD_LENGTH = 40;

/** The round a replacement made now applies to: the draft round if there is one, else the next one to generate. */
export function nextReplacementRound(t: Tournament): number {
  const last = t.rounds[t.rounds.length - 1];
  return last && last.status === 'draft' ? last.number : t.rounds.length + 1;
}

/** Swaps `fromId` for `toId` in round `roundNumber`'s matches and forced pairings (draft round only). */
function swapCoachInRound(t: Tournament, roundNumber: number, fromId: string, toId: string, now: string): void {
  for (const c of t.challenges) {
    if (c.round !== roundNumber) continue;
    if (c.team1Id === fromId) c.team1Id = toId;
    else if (c.team2Id === fromId) c.team2Id = toId;
    else continue;
    c.updatedAt = now;
  }
  const round = t.rounds.find((r) => r.number === roundNumber);
  if (round?.lockedPairs) round.lockedPairs = round.lockedPairs.map(([x, y]) => [x === fromId ? toId : x, y === fromId ? toId : y]);
}

/**
 * Replaces `outTeamId` from the next round on (see nextReplacementRound) by a new substitute coach
 * or by a coach not playing that round (of the same squad, in team format); in a draft round, the
 * incoming coach takes the outgoing one's matches. Swiss tournaments only (individual or team).
 * Mutates `t`, returns the replacement.
 */
export function applyReplacement(t: Tournament, body: CreateReplacementRequest | null, now: string): Replacement {
  if (t.mode !== 'swiss') throw forbidden('Les remplacements ne concernent que les tournois en rondes suisses', 'not_swiss');
  const round = nextReplacementRound(t);
  if (t.roundCount !== null && round > t.roundCount) throw forbidden('Toutes les rondes ont déjà été jouées', 'tournament_finished');

  const out = t.teams.find((tm) => tm.id === body?.outTeamId);
  if (!out) throw notFound('Coach à remplacer introuvable');
  const squadId = out.squadId;
  const playing = activeCoaches(t.teams, t.replacements, round);
  if (!playing.has(out.id)) throw forbidden(`${out.coachName} ne joue déjà pas la ronde ${round}`, 'coach_not_playing');
  const draftRound = t.rounds.find((r) => r.number === round && r.status === 'draft');
  if (draftRound && t.challenges.some((c) => c.round === round && c.result && (c.team1Id === out.id || c.team2Id === out.id))) {
    throw forbidden(`Le match de ${out.coachName} a déjà un résultat`, 'match_already_played');
  }

  let incoming: Team;
  if (body?.inTeamId) {
    const existing = t.teams.find((tm) => tm.id === body.inTeamId);
    if (!existing) throw notFound('Coach remplaçant introuvable');
    if (t.format === 'team' && existing.squadId !== squadId) throw badRequest("Le remplaçant doit être un coach de la même équipe");
    if (playing.has(existing.id)) throw badRequest(`${existing.coachName} joue déjà la ronde ${round}`);
    incoming = existing;
  } else if (body?.substitute) {
    const coachName = body.substitute.coachName?.trim();
    const race = body.substitute.race?.trim();
    if (!coachName || !race) throw badRequest('Nom du coach et race du remplaçant obligatoires');
    if (coachName.length > MAX_FIELD_LENGTH || race.length > MAX_FIELD_LENGTH) {
      throw badRequest(`Nom du coach et race : ${MAX_FIELD_LENGTH} caractères maximum`);
    }
    if (t.teams.some((tm) => tm.coachName.toLowerCase() === coachName.toLowerCase())) {
      throw conflict(`Un coach nommé "${coachName}" est déjà inscrit : choisissez-le comme coach existant`, 'coach_name_taken');
    }
    incoming = {
      id: uuidv4(),
      password: derivePasswordFromCoachName(coachName),
      name: generateDefaultTeamName(t.teams, coachName),
      coachName,
      race,
      nafNumber: validateNafNumber(body.substitute.nafNumber),
      squadId,
      poolId: null,
      createdAt: now,
      rosterImage: null,
      rosterStatus: 'created',
      substitute: true,
    };
    t.teams.push(incoming);
  } else {
    throw badRequest('Indiquez le remplaçant : un nouveau coach ou un coach existant de la même équipe');
  }

  const replacement: Replacement = { id: uuidv4(), round, outTeamId: out.id, inTeamId: incoming.id, createdAt: now };
  t.replacements = [...(t.replacements ?? []), replacement];
  if (draftRound) swapCoachInRound(t, round, out.id, incoming.id, now);
  return replacement;
}

/**
 * Undoes a replacement whose round hasn't been launched yet, and that is the latest one involving
 * either of its coaches. A substitute created for it, with no other match or replacement, is removed.
 */
export function revertReplacement(t: Tournament, replacementId: string, now: string): void {
  const replacements = t.replacements ?? [];
  const replacement = replacements.find((r) => r.id === replacementId);
  if (!replacement) throw notFound('Remplacement introuvable');
  const round = t.rounds.find((r) => r.number === replacement.round);
  if (round?.status === 'launched') throw forbidden('La ronde de ce remplacement est déjà lancée', 'round_already_launched');
  const involves = (r: Replacement) => [r.outTeamId, r.inTeamId].some((id) => id === replacement.outTeamId || id === replacement.inTeamId);
  const later = replacements.filter((r) => r !== replacement && involves(r) && (r.round > replacement.round || r.createdAt > replacement.createdAt));
  if (later.length > 0) throw forbidden("Annulez d'abord le remplacement suivant de ces coachs", 'later_replacement');
  if (t.challenges.some((c) => c.round === replacement.round && c.result && (c.team1Id === replacement.inTeamId || c.team2Id === replacement.inTeamId))) {
    throw forbidden('Le remplaçant a déjà un résultat dans cette ronde', 'match_already_played');
  }

  if (round?.status === 'draft') swapCoachInRound(t, replacement.round, replacement.inTeamId, replacement.outTeamId, now);
  t.replacements = replacements.filter((r) => r !== replacement);
  const incoming = t.teams.find((tm) => tm.id === replacement.inTeamId);
  const stillUsed =
    t.replacements.some((r) => r.outTeamId === incoming?.id || r.inTeamId === incoming?.id) ||
    t.challenges.some((c) => c.team1Id === incoming?.id || c.team2Id === incoming?.id);
  if (incoming?.substitute && !stillUsed) t.teams = t.teams.filter((tm) => tm !== incoming);
}

export async function createReplacement(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const body = await c.req.json<CreateReplacementRequest>().catch(() => null);
  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    applyReplacement(t, body, new Date().toISOString());
  });
  return c.json(toAdminTournamentView(await storage.getTournament(tournamentId)));
}

export async function deleteReplacement(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    revertReplacement(t, c.req.param('replacementId')!, new Date().toISOString());
  });
  return c.json(toAdminTournamentView(await storage.getTournament(tournamentId)));
}
