import type { Context } from 'hono';
import type { CreateBackupResponse, ListBackupsResponse } from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';

export async function listBackups(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  const tournament = await storage.getTournament(tournamentId);
  requireAdmin(tournament, token);

  const backups = await storage.listBackups(tournamentId);
  const response: ListBackupsResponse = { backups };
  return c.json(response);
}

export async function createBackup(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  const tournament = await storage.getTournament(tournamentId);
  requireAdmin(tournament, token);

  const backup: CreateBackupResponse = await storage.backupTournament(tournamentId);
  return c.json(backup, 201);
}
