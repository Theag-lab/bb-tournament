import type { Context } from 'hono';
import { buildNafExport } from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';

export async function exportNaf(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const tournament = await storage.getTournament(tournamentId);
  requireAdmin(tournament, token);

  const xml = buildNafExport(tournament);
  const filename = tournament.name.replace(/[^a-zA-Z0-9-_]+/g, '_') || 'export';
  return c.body(xml, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Disposition': `attachment; filename="naf-${filename}.xml"`,
  });
}
