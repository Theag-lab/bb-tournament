import { Injectable, signal } from '@angular/core';

/** Name of the tournament the current page shows, so the site header can display it. */
@Injectable({ providedIn: 'root' })
export class CurrentTournamentService {
  readonly current = signal<{ id: string; name: string } | null>(null);

  set(id: string, name: string): void {
    const now = this.current();
    if (now?.id !== id || now.name !== name) this.current.set({ id, name });
  }
}
