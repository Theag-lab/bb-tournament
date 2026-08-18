import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RACES, type PublicTournament } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, scoreboardUrl } from '../../core/links';

const POLL_INTERVAL_MS = 15000;

@Component({
  selector: 'app-scoreboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scoreboard.component.html',
  styleUrl: './scoreboard.component.scss',
})
export class ScoreboardComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  readonly races = RACES;

  tournamentId = '';
  tournament: PublicTournament | null = null;
  loading = true;
  error: string | null = null;

  showJoinForm = false;
  joinBusy = false;
  joinError: string | null = null;
  joinName = '';
  joinCoachName = '';
  joinRace = '';

  createdTeam: { teamId: string; token: string } | null = null;
  copied = false;
  shareCopied = false;

  async ngOnInit(): Promise<void> {
    this.tournamentId = this.route.snapshot.paramMap.get('tournamentId')!;
    await this.load();
    this.pollHandle = setInterval(() => this.load(true), POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollHandle) clearInterval(this.pollHandle);
  }

  async load(silent = false): Promise<void> {
    if (!silent) this.loading = true;
    try {
      this.tournament = await this.api.getTournament(this.tournamentId);
      this.error = null;
    } catch (err) {
      this.error = extractErrorMessage(err);
    } finally {
      this.loading = false;
    }
  }

  teamName(teamId: string): string {
    return this.tournament?.teams.find((t) => t.id === teamId)?.name ?? '—';
  }

  teamCoach(teamId: string): string {
    return this.tournament?.teams.find((t) => t.id === teamId)?.coachName ?? '—';
  }

  async submitJoin(): Promise<void> {
    const name = this.joinName.trim();
    const coachName = this.joinCoachName.trim();
    const race = this.joinRace.trim();
    if (!name || !coachName || !race) return;
    this.joinBusy = true;
    this.joinError = null;
    try {
      const res = await this.api.createTeam(this.tournamentId, { name, coachName, race });
      this.createdTeam = { teamId: res.teamId, token: res.participantToken };
      await this.load(true);
    } catch (err) {
      this.joinError = extractErrorMessage(err);
    } finally {
      this.joinBusy = false;
    }
  }

  get createdTeamUrl(): string {
    if (!this.createdTeam) return '';
    return participantUrl(this.tournamentId, this.createdTeam.teamId, this.createdTeam.token);
  }

  async copyCreatedTeamLink(): Promise<void> {
    this.copied = await copyToClipboard(this.createdTeamUrl);
  }

  async copyShareLink(): Promise<void> {
    this.shareCopied = await copyToClipboard(scoreboardUrl(this.tournamentId));
  }

  goToMyTeam(): void {
    if (!this.createdTeam) return;
    this.router.navigate(['/tournaments', this.tournamentId, 'team', this.createdTeam.teamId, this.createdTeam.token]);
  }
}
