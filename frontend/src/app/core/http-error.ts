import { HttpErrorResponse } from '@angular/common/http';

export function extractErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const message = (err.error as { error?: { message?: string } } | null)?.error?.message;
    if (message) return message;
    if (err.status === 0) return 'Impossible de contacter le serveur. Vérifiez votre connexion.';
    return `Erreur ${err.status}`;
  }
  return 'Une erreur inattendue est survenue';
}
