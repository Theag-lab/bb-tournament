import type { Context } from 'hono';
import { FUMBBL_TAG_MAX_LENGTH, type FumbblTrackingConfig } from '@bb-tournament/shared';
import * as storage from '../storage';
import { requireAdmin } from '../auth';
import { toAdminTournamentView } from '../sanitize';
import { badRequest } from '../errors';

/** Validates an admin's FUMBBL tracking settings: a tag is required to turn tracking on. */
export function validateFumbblTracking(body: Partial<FumbblTrackingConfig> | null): FumbblTrackingConfig {
  if (!body || typeof body.enabled !== 'boolean') throw badRequest('enabled must be a boolean', 'invalid_fumbbl_tracking');
  const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
  if (body.enabled && !tag) throw badRequest('A FUMBBL team-name tag is required to enable tracking', 'fumbbl_tag_required');
  if (tag.length > FUMBBL_TAG_MAX_LENGTH) {
    throw badRequest(`The FUMBBL tag must be at most ${FUMBBL_TAG_MAX_LENGTH} characters`, 'invalid_fumbbl_tracking');
  }
  return { enabled: body.enabled, tag };
}

/** Turns automatic FUMBBL results on/off for a tournament and (un)subscribes it from the cron Lambda. */
export async function updateFumbblTracking(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');
  const config = validateFumbblTracking(await c.req.json<Partial<FumbblTrackingConfig>>().catch(() => null));

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    t.fumbbl = config;
  });
  await storage.setFumbblSubscription(tournamentId, config.enabled);

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}
