/**
 * Backups are just regular tournament JSON files named `<tournamentId>-bkp-<N>.json` (see the
 * backend's storage.backupTournament) — so a backup is addressable, and fully usable, as its own
 * independent "tournament" simply by using `<tournamentId>-bkp-<N>` as the id everywhere (every
 * page/endpoint already keys purely off whatever id string it's given, with no other special
 * casing needed). This only detects that pattern client-side, to show a banner so nobody mistakes
 * a backup sandbox for the live tournament.
 */
export interface BackupIdInfo {
  originalTournamentId: string;
  backupIndex: number;
}

const BACKUP_ID_PATTERN = /^(.+)-bkp-(\d+)$/;

export function parseBackupId(tournamentId: string): BackupIdInfo | null {
  const match = tournamentId.match(BACKUP_ID_PATTERN);
  if (!match) return null;
  return { originalTournamentId: match[1], backupIndex: Number(match[2]) };
}
