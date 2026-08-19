import type { Context } from 'hono';
import type { SwapRoundMatchesRequest } from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { generateNextRound, launchRound, swapRoundMatches } from '../rounds';
import { toAdminTournamentView } from '../sanitize';
import { badRequest } from '../errors';

function parseRoundNumber(c: Context): number {
  const raw = c.req.param('roundNumber');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid round number');
  return n;
}

export async function generateRound(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    generateNextRound(t);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament), 201);
}

export async function swapMatches(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const roundNumber = parseRoundNumber(c);
  const token = c.req.query('token');
  const body = await c.req.json<SwapRoundMatchesRequest>().catch(() => null);
  if (!body?.matchId1 || !body?.matchId2) throw badRequest('matchId1 and matchId2 are required');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    swapRoundMatches(t, roundNumber, body.matchId1, body.matchId2);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}

export async function launch(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const roundNumber = parseRoundNumber(c);
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    launchRound(t, roundNumber);
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}
