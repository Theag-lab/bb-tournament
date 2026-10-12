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

/** The backend's machine-readable error code and details (see AppError), when the error carries them. */
export function extractErrorBody(err: unknown): { code: string | null; details: Record<string, unknown> } {
  const error = err instanceof HttpErrorResponse ? (err.error as { error?: { code?: string; details?: Record<string, unknown> } } | null)?.error : null;
  return { code: error?.code ?? null, details: error?.details ?? {} };
}
