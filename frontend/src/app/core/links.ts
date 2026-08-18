export function scoreboardUrl(tournamentId: string): string {
  return `${location.origin}/tournaments/${tournamentId}`;
}

export function participantUrl(tournamentId: string, teamId: string, password: string): string {
  return `${location.origin}/tournaments/${tournamentId}/team/${teamId}/${encodeURIComponent(password)}`;
}

export function rosterImageUrl(tournamentId: string, teamId: string, updatedAt: string): string {
  return `/roster-images/${tournamentId}/${teamId}?v=${encodeURIComponent(updatedAt)}`;
}

export function adminUrl(tournamentId: string, adminToken: string): string {
  return `${location.origin}/tournaments/${tournamentId}/admin/${adminToken}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
