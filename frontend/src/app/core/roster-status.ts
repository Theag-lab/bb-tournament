import type { RosterStatus } from '@bb-tournament/shared';

export function rosterStatusLabel(status: RosterStatus | undefined): string {
  switch (status) {
    case 'submitted':
      return 'Soumise pour validation';
    case 'validated':
      return 'Validée';
    default:
      return 'Créée';
  }
}
