import { TEAM_PASSWORD_MAX_LENGTH, TEAM_PASSWORD_MIN_LENGTH } from './types';

/**
 * Bulk-import teams get a temporary password equal to their coach name (the admin communicates it
 * out of band; the coach is expected to change it via their own team page). Deterministically
 * padded/truncated to satisfy the normal password length bounds, since a bare coach name can be
 * shorter than TEAM_PASSWORD_MIN_LENGTH. Shared so the admin import preview (frontend) can flag
 * the exact same "already registered" collisions the backend will otherwise reject.
 */
export function derivePasswordFromCoachName(coachName: string): string {
  let password = coachName;
  while (password.length < TEAM_PASSWORD_MIN_LENGTH) password += coachName;
  return password.slice(0, TEAM_PASSWORD_MAX_LENGTH);
}
