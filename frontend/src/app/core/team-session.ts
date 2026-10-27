/**
 * "Remember my team" cookie: once a coach has opened their team page, the scoreboard of that
 * tournament offers a "Gérer mon équipe" button without re-entering the password. Scoped to the
 * tournament's path so each tournament remembers its own team, and long-lived (one year) since a
 * tournament runs over a few days at most. Holds the same team id + password as the team-page URL
 * the coach already bookmarks — nothing more sensitive than that.
 */
const COOKIE_NAME = 'bbt_team';
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface TeamSession {
  teamId: string;
  password: string;
}

function cookiePath(tournamentId: string): string {
  return `/tournaments/${encodeURIComponent(tournamentId)}`;
}

function writeCookie(tournamentId: string, value: string, maxAge: number): void {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${value}; Path=${cookiePath(tournamentId)}; Max-Age=${maxAge}; SameSite=Lax${secure}`;
}

export function rememberTeam(tournamentId: string, session: TeamSession): void {
  writeCookie(tournamentId, encodeURIComponent(JSON.stringify(session)), MAX_AGE_SECONDS);
}

export function forgetTeam(tournamentId: string): void {
  writeCookie(tournamentId, '', 0);
}

/** The remembered team, readable from any page under the tournament's path (scoreboard included). */
export function rememberedTeam(): TeamSession | null {
  const raw = document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as Partial<TeamSession>;
    return typeof parsed.teamId === 'string' && typeof parsed.password === 'string'
      ? { teamId: parsed.teamId, password: parsed.password }
      : null;
  } catch {
    return null;
  }
}
