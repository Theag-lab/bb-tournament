import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { PublicTournament } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { scoreboardUrl } from '../../core/links';
import { qrCodeDataUrl } from '../../core/qrcode';

const POLL_INTERVAL_MS = 15000;
const TICK_INTERVAL_MS = 1000;

/** mm:ss under an hour, hh:mm:ss beyond — read easily from across a room either way. */
function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

@Component({
  selector: 'app-kiosk',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './kiosk.component.html',
  styleUrl: './kiosk.component.scss',
})
export class KioskComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  tournamentId = '';
  tournament: PublicTournament | null = null;
  loading = true;
  error: string | null = null;
  qrDataUrl = '';
  private now = Date.now();

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    this.qrDataUrl = qrCodeDataUrl(scoreboardUrl(this.tournamentId));
    await this.load();
    this.pollHandle = setInterval(() => this.load(), POLL_INTERVAL_MS);
    this.tickHandle = setInterval(() => {
      this.now = Date.now();
    }, TICK_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.tickHandle) clearInterval(this.tickHandle);
  }

  private async load(): Promise<void> {
    try {
      this.tournament = await this.api.getTournament(this.tournamentId);
      this.error = null;
    } catch (err) {
      this.error = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  get currentRoundNumber(): number | null {
    const launched = (this.tournament?.rounds ?? []).filter((r) => r.status === 'launched').map((r) => r.number);
    return launched.length > 0 ? Math.max(...launched) : null;
  }

  private get roundMatches(): PublicTournament['challenges'] {
    const round = this.currentRoundNumber;
    if (round === null) return [];
    return (this.tournament?.challenges ?? []).filter((c) => c.round === round);
  }

  get completedCount(): number {
    return this.roundMatches.filter((c) => c.status === 'completed').length;
  }

  get totalCount(): number {
    return this.roundMatches.length;
  }

  /** null = timer not running (admin hasn't started it for this round yet). */
  get remainingSeconds(): number | null {
    const timer = this.tournament?.roundTimer;
    if (!timer?.startedAt) return null;
    const elapsed = (this.now - new Date(timer.startedAt).getTime()) / 1000;
    return Math.max(0, timer.durationSeconds - elapsed);
  }

  get remainingLabel(): string {
    const remaining = this.remainingSeconds;
    if (remaining === null) return formatDuration(this.tournament?.roundTimer.durationSeconds ?? 0);
    return formatDuration(remaining);
  }

  get timerExpired(): boolean {
    return this.remainingSeconds !== null && this.remainingSeconds <= 0;
  }

  get timerRunning(): boolean {
    return this.remainingSeconds !== null;
  }
}
