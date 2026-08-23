import type { Context } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import type { AssignTeamPoolRequest, Pool } from '@bb-tournament/shared';
import * as storage from '../storage';
import { findTeamById, requireAdmin } from '../auth';
import { toAdminTournamentView } from '../sanitize';
import { shuffle } from '../pairing';
import { badRequest, forbidden, notFound } from '../errors';

const POOL_NAME_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function poolName(index: number): string {
  // A, B, ..., Z, AA, AB, ... — plenty of headroom for any realistic team count.
  let n = index;
  let name = '';
  do {
    name = POOL_NAME_LETTERS[n % 26] + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Poule ${name}`;
}

/**
 * Splits `teamIds` into as-even-as-possible pools sized close to `poolSize`: pool count is
 * `round(teamIds.length / poolSize)` (rounding, not ceil, so pools land near the target size
 * instead of always erring toward one extra small pool), then a shuffled round-robin deal spreads
 * teams across pools within one of each other in size.
 */
export function computePoolAssignment(teamIds: string[], poolSize: number): string[][] {
  const poolCount = Math.max(1, Math.round(teamIds.length / poolSize));
  const pools: string[][] = Array.from({ length: poolCount }, () => []);
  const shuffled = shuffle(teamIds);
  shuffled.forEach((teamId, i) => pools[i % poolCount].push(teamId));
  return pools;
}

export async function generatePools(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const token = c.req.query('token');

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.mode !== 'pools_knockout') throw forbidden('This tournament is not in pools_knockout mode');
    if (t.poolSize === null) throw forbidden('poolSize is not configured for this tournament');
    if (t.rounds.length > 0) {
      throw forbidden('Pools cannot be (re)generated once a round has been generated', 'rounds_already_started');
    }
    if (t.teams.length < 2) throw badRequest('At least 2 teams are needed to generate pools');

    const now = new Date().toISOString();
    const assignment = computePoolAssignment(
      t.teams.map((tm) => tm.id),
      t.poolSize
    );
    const pools: Pool[] = assignment.map((_, i) => ({ id: uuidv4(), name: poolName(i), createdAt: now }));
    const teamById = new Map(t.teams.map((tm) => [tm.id, tm]));
    assignment.forEach((teamIds, i) => {
      for (const teamId of teamIds) {
        teamById.get(teamId)!.poolId = pools[i].id;
      }
    });
    t.pools = pools;
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament), 201);
}

export async function assignTeamPool(c: Context) {
  const tournamentId = c.req.param('tournamentId')!;
  const teamId = c.req.param('teamId')!;
  const token = c.req.query('token');
  const body = await c.req.json<AssignTeamPoolRequest>().catch(() => null);

  await storage.updateTournament(tournamentId, (t) => {
    requireAdmin(t, token);
    if (t.mode !== 'pools_knockout') throw forbidden('This tournament is not in pools_knockout mode');
    const team = findTeamById(t, teamId);
    if (body?.poolId) {
      const pool = t.pools.find((p) => p.id === body.poolId);
      if (!pool) throw notFound('Pool not found');
      team.poolId = pool.id;
    } else {
      team.poolId = null;
    }
  });

  const tournament = await storage.getTournament(tournamentId);
  return c.json(toAdminTournamentView(tournament));
}
