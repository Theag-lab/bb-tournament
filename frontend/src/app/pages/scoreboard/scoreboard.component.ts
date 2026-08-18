import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RACES, type PublicTeam, type PublicTournament } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';

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
  joinPassword = '';

  createdTeam: { teamId: string; password: string } | null = null;
  copied = false;
  shareCopied = false;

  showFindForm = false;
  findCoachName = '';
  findPassword = '';
  findBusy = false;
  findError: string | null = null;

  selectedRosterTeam: PublicTeam | null = null;

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
    const password = this.joinPassword.trim();
    if (!name || !coachName || !race || !password) return;
    this.joinBusy = true;
    this.joinError = null;
    try {
      const res = await this.api.createTeam(this.tournamentId, { name, coachName, race, password });
      this.createdTeam = { teamId: res.teamId, password };
      await this.load(true);
    } catch (err) {
      this.joinError = extractErrorMessage(err);
    } finally {
      this.joinBusy = false;
    }
  }

  get createdTeamUrl(): string {
    if (!this.createdTeam) return '';
    return participantUrl(this.tournamentId, this.createdTeam.teamId, this.createdTeam.password);
  }

  async copyCreatedTeamLink(): Promise<void> {
    this.copied = await copyToClipboard(this.createdTeamUrl);
  }

  async copyShareLink(): Promise<void> {
    this.shareCopied = await copyToClipboard(scoreboardUrl(this.tournamentId));
  }

  goToMyTeam(): void {
    if (!this.createdTeam) return;
    this.router.navigate([
      '/tournaments',
      this.tournamentId,
      'team',
      this.createdTeam.teamId,
      this.createdTeam.password,
    ]);
  }

  async submitFind(): Promise<void> {
    const coachName = this.findCoachName.trim();
    const password = this.findPassword.trim();
    if (!coachName || !password) return;
    this.findBusy = true;
    this.findError = null;
    try {
      const res = await this.api.findMyTeam(this.tournamentId, coachName, password);
      this.router.navigate(['/tournaments', this.tournamentId, 'team', res.teamId, password]);
    } catch (err) {
      this.findError = extractErrorMessage(err);
    } finally {
      this.findBusy = false;
    }
  }

  openRoster(team: PublicTeam): void {
    this.selectedRosterTeam = team;
  }

  openRosterById(teamId: string): void {
    const team = this.tournament?.teams.find((t) => t.id === teamId);
    if (team) this.selectedRosterTeam = team;
  }

  closeRoster(): void {
    this.selectedRosterTeam = null;
  }

  selectedRosterImageUrl(): string | null {
    const team = this.selectedRosterTeam;
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }
}
