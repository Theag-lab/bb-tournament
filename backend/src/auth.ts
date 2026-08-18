import type { Team, Tournament } from '@bb-tournament/shared';
import { unauthorized } from './errors';

export function findTeamByToken(t: Tournament, token: string | undefined | null): Team {
  if (!token) throw unauthorized('Missing participant token');
  const team = t.teams.find((team) => team.participantToken === token);
  if (!team) throw unauthorized('Invalid participant token');
  return team;
}

export function isAdmin(t: Tournament, token: string | undefined | null): boolean {
  return !!token && token === t.adminToken;
}

export function requireAdmin(t: Tournament, token: string | undefined | null): void {
  if (!isAdmin(t, token)) throw unauthorized('Invalid admin token');
}
