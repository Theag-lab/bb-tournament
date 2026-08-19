import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { RACES, type PublicTeam, type PublicTournament, type StandingEntry } from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { copyToClipboard, participantUrl, rosterImageUrl, scoreboardUrl } from '../../core/links';
import { renderMarkdown } from '../../core/markdown';
import { rosterStatusLabel } from '../../core/roster-status';

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
  readonly rosterStatusLabel = rosterStatusLabel;

  tournamentId = '';
  tournament: PublicTournament | null = null;
  loading = true;
  error: string | null = null;

  activeTab = 'scores';
  descriptionHtml = '';

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

  selectedTeam: PublicTeam | null = null;

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
      this.descriptionHtml = renderMarkdown(this.tournament.description);
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

  teamRace(teamId: string): string {
    return this.tournament?.teams.find((t) => t.id === teamId)?.race ?? '—';
  }

  get launchedRounds() {
    return this.tournament?.rounds.filter((r) => r.status === 'launched') ?? [];
  }

  get registrationClosed(): boolean {
    return !!this.tournament && this.tournament.mode !== 'ladder' && this.tournament.rounds.length > 0;
  }

  get roundInPreparation(): boolean {
    return !!this.tournament?.rounds.some((r) => r.status === 'draft');
  }

  freeChallenges(): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === null) ?? [];
  }

  roundMatches(roundNumber: number): PublicTournament['challenges'] {
    return this.tournament?.challenges.filter((c) => c.round === roundNumber) ?? [];
  }

  roundTabId(roundNumber: number): string {
    return `round-${roundNumber}`;
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

  async shareTournament(): Promise<void> {
    const url = scoreboardUrl(this.tournamentId);
    if (navigator.share) {
      try {
        await navigator.share({ title: this.tournament?.name ?? 'Tournoi Blood Bowl', url });
        return;
      } catch {
        // User cancelled the native share sheet, or it failed — fall back to copying below.
      }
    }
    this.shareCopied = await copyToClipboard(url);
    if (this.shareCopied) {
      setTimeout(() => (this.shareCopied = false), 2000);
    }
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

  openTeam(team: PublicTeam): void {
    this.selectedTeam = team;
  }

  openTeamById(teamId: string): void {
    const team = this.tournament?.teams.find((t) => t.id === teamId);
    if (team) this.selectedTeam = team;
  }

  closeTeam(): void {
    this.selectedTeam = null;
    this.lightboxImageUrl = null;
  }

  selectedTeamImageUrl(): string | null {
    const team = this.selectedTeam;
    if (!team?.rosterImage) return null;
    return rosterImageUrl(this.tournamentId, team.id, team.rosterImage.updatedAt);
  }

  lightboxImageUrl: string | null = null;

  openImageLightbox(): void {
    this.lightboxImageUrl = this.selectedTeamImageUrl();
  }

  closeImageLightbox(): void {
    this.lightboxImageUrl = null;
  }

  selectedTeamStanding(): StandingEntry | null {
    if (!this.selectedTeam) return null;
    return this.tournament?.standings.find((s) => s.teamId === this.selectedTeam!.id) ?? null;
  }

  selectedTeamChallenges(): PublicTournament['challenges'] {
    if (!this.selectedTeam) return [];
    const id = this.selectedTeam.id;
    return (this.tournament?.challenges.filter((c) => c.team1Id === id || c.team2Id === id) ?? [])
      .slice()
      .sort((a, b) => (b.result?.playedAt ?? b.updatedAt).localeCompare(a.result?.playedAt ?? a.updatedAt));
  }

  opponentId(c: PublicTournament['challenges'][number], teamId: string): string {
    return c.team1Id === teamId ? c.team2Id : c.team1Id;
  }

  matchScoreLabel(c: PublicTournament['challenges'][number], teamId: string): string {
    if (!c.result) return '—';
    const mine = c.team1Id === teamId ? c.result.team1Td : c.result.team2Td;
    const theirs = c.team1Id === teamId ? c.result.team2Td : c.result.team1Td;
    return `${mine} - ${theirs}`;
  }

  matchOutcome(c: PublicTournament['challenges'][number], teamId: string): 'win' | 'draw' | 'loss' | null {
    if (!c.result) return null;
    const mine = c.team1Id === teamId ? c.result.team1Points : c.result.team2Points;
    const theirs = c.team1Id === teamId ? c.result.team2Points : c.result.team1Points;
    if (mine > theirs) return 'win';
    if (mine < theirs) return 'loss';
    return 'draw';
  }

  matchOutcomeLabel(c: PublicTournament['challenges'][number], teamId: string): string {
    const outcome = this.matchOutcome(c, teamId);
    if (outcome === 'win') return 'Victoire';
    if (outcome === 'loss') return 'Défaite';
    if (outcome === 'draw') return 'Nul';
    return '';
  }

  private ranking(stat: (s: StandingEntry) => number): StandingEntry[] {
    return (this.tournament?.standings ?? [])
      .filter((s) => s.gamesPlayed > 0)
      .slice()
      .sort((a, b) => stat(b) - stat(a));
  }

  bashlordRanking(): StandingEntry[] {
    return this.ranking((s) => s.casFor);
  }

  aggroLordRanking(): StandingEntry[] {
    return this.ranking((s) => s.aggFor);
  }

  topScorerRanking(): StandingEntry[] {
    return this.ranking((s) => s.tdFor);
  }

  rankMedal(index: number): string {
    return index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '';
  }
}
