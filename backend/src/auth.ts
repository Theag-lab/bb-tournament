import { TEAM_PASSWORD_MAX_LENGTH, TEAM_PASSWORD_MIN_LENGTH, type Team, type Tournament } from '@bb-tournament/shared';
import { badRequest, notFound, unauthorized } from './errors';

/** Validates a coach-chosen team password/access code, throwing a 400 on bad input. */
export function validatePassword(raw: string | undefined | null): string {
  if (!raw) throw badRequest('Un mot de passe est requis', 'password_required');
  const password = raw.trim();
  if (password.length < TEAM_PASSWORD_MIN_LENGTH || password.length > TEAM_PASSWORD_MAX_LENGTH) {
    throw badRequest(
      `Le mot de passe doit contenir entre ${TEAM_PASSWORD_MIN_LENGTH} et ${TEAM_PASSWORD_MAX_LENGTH} caractères`,
      'invalid_password_length'
    );
  }
  return password;
}

export function findTeamById(t: Tournament, teamId: string | undefined | null): Team {
  const team = t.teams.find((tm) => tm.id === teamId);
  if (!team) throw notFound('Team not found');
  return team;
}

/** Verifies a team's password (exact, case-sensitive match), throwing 401 on mismatch. */
export function authenticateTeam(t: Tournament, teamId: string | undefined | null, password: string | undefined | null): Team {
  const team = findTeamById(t, teamId);
  if (!password || team.password !== password) throw unauthorized('Identifiants invalides');
  return team;
}

export function isAdmin(t: Tournament, token: string | undefined | null): boolean {
  return !!token && token === t.adminToken;
}

export function requireAdmin(t: Tournament, token: string | undefined | null): void {
  if (!isAdmin(t, token)) throw unauthorized('Jeton admin invalide');
}
