import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  MAX_POOL_SIZE,
  MAX_QUALIFIERS_PER_POOL,
  MAX_ROUND_COUNT,
  MAX_SQUAD_SIZE,
  MIN_POOL_SIZE,
  MIN_QUALIFIERS_PER_POOL,
  MIN_ROUND_COUNT,
  MIN_SQUAD_SIZE,
  ORGANIZER_COACH_NAME_MAX_LENGTH,
  TOURNAMENT_ID_MAX_LENGTH,
  TOURNAMENT_ID_MIN_LENGTH,
  TOURNAMENT_ID_PATTERN,
  type TournamentFormat,
  type TournamentMode,
} from '@bb-tournament/shared';
import { ApiService } from '../../core/api.service';
import { extractErrorMessage } from '../../core/http-error';
import { adminUrl, copyToClipboard } from '../../core/links';

type WizardStep = 'name' | 'format' | 'mode' | 'squad-size' | 'rounds' | 'pools' | 'validation' | 'review';

/** Suggests a URL-safe tournament id from its name — kept in sync until the admin edits it by hand. */
function slugify(value: string, maxLength: number): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents (é -> e, etc.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return slug.replace(/-+$/g, ''); // truncation may leave a trailing hyphen
}

interface ScreenshotSlide {
  image: string;
  alt: string;
  title: string;
  description: string;
}

const CAROUSEL_INTERVAL_MS = 5000;

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly slides: ScreenshotSlide[] = [
    {
      image: '/screenshots/scoreboard.png',
      alt: 'Tableau des scores public',
      title: 'Classement en direct',
      description: 'Points, V-N-D, touchdowns et casualties, actualisés toutes les 60 secondes — partageable en un lien.',
    },
    {
      image: '/screenshots/team.png',
      alt: "Roster",
      title: 'Vision sur le roster',
      description: 'Roster validé, statistiques et historique des matchs — chaque équipe du classement est cliquable.',
    },
    {
      image: '/screenshots/round4-squad.png',
      alt: 'Tournoi par squad',
      title: 'Format par équipe, visualisation des rounds',
      description: 'Escouades, double classement, BashLord et AggroLord déclinés par équipe et en individuel.',
    },
    {
      image: '/screenshots/admin.png',
      alt: 'Panneau administrateur',
      title: 'Panneau admin complet',
      description: 'Rondes, rosters, description du tournoi, export NAF — tout au même endroit, sans jonglerie.',
    }
  ];

  activeSlide = 0;
  private carouselTimer: ReturnType<typeof setInterval> | null = null;
  readonly brokenImages = new Set<number>();

  ngOnInit(): void {
    this.carouselTimer = setInterval(() => this.nextSlide(), CAROUSEL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.carouselTimer) clearInterval(this.carouselTimer);
  }

  nextSlide(): void {
    this.activeSlide = (this.activeSlide + 1) % this.slides.length;
  }

  prevSlide(): void {
    this.activeSlide = (this.activeSlide - 1 + this.slides.length) % this.slides.length;
  }

  goToSlide(index: number): void {
    this.activeSlide = index;
  }

  onSlideImageError(index: number): void {
    this.brokenImages.add(index);
  }

  pauseCarousel(): void {
    if (this.carouselTimer) {
      clearInterval(this.carouselTimer);
      this.carouselTimer = null;
    }
  }

  resumeCarousel(): void {
    if (!this.carouselTimer) {
      this.carouselTimer = setInterval(() => this.nextSlide(), CAROUSEL_INTERVAL_MS);
    }
  }

  readonly minRoundCount = MIN_ROUND_COUNT;
  readonly maxRoundCount = MAX_ROUND_COUNT;
  readonly minSquadSize = MIN_SQUAD_SIZE;
  readonly maxSquadSize = MAX_SQUAD_SIZE;
  readonly minPoolSize = MIN_POOL_SIZE;
  readonly maxPoolSize = MAX_POOL_SIZE;
  readonly minQualifiersPerPool = MIN_QUALIFIERS_PER_POOL;
  readonly maxQualifiersPerPool = MAX_QUALIFIERS_PER_POOL;
  readonly idMinLength = TOURNAMENT_ID_MIN_LENGTH;
  readonly idMaxLength = TOURNAMENT_ID_MAX_LENGTH;
  readonly organizerCoachNameMaxLength = ORGANIZER_COACH_NAME_MAX_LENGTH;

  name = '';
  organizerCoachName = '';
  id = '';
  private idManuallyEdited = false;
  format: TournamentFormat = 'individual';
  mode: TournamentMode = 'ladder';
  roundCount = 3;
  squadSize = 4;
  poolSize = 4;
  poolRoundCount = 3;
  qualifiersPerPool = 2;
  requireRosterValidation = false;
  requireResultConfirmation = true;

  busy = false;
  error: string | null = null;
  createdAdminLink: string | null = null;
  createdAdminToken: string | null = null;
  createdTournamentId: string | null = null;

  joinTournamentId = '';
  copied = false;

  stepIndex = 0;

  get steps(): WizardStep[] {
    const steps: WizardStep[] = ['name', 'format'];
    if (this.format === 'individual') {
      steps.push('mode');
      if (this.mode === 'pools_knockout') steps.push('pools');
      else if (this.mode !== 'ladder') steps.push('rounds');
    } else {
      steps.push('squad-size', 'rounds');
    }
    steps.push('validation', 'review');
    return steps;
  }

  formatLabel(format: TournamentFormat): string {
    return format === 'individual' ? 'Individuel' : 'Par équipe';
  }

  onNameChange(value: string): void {
    this.name = value;
    if (!this.idManuallyEdited) this.id = slugify(value, this.idMaxLength);
  }

  onIdChange(value: string): void {
    this.id = value;
    this.idManuallyEdited = true;
  }

  get idError(): string | null {
    const id = this.id.trim();
    if (!id) return 'Identifiant requis';
    if (id.length < this.idMinLength || id.length > this.idMaxLength) {
      return `Entre ${this.idMinLength} et ${this.idMaxLength} caractères`;
    }
    if (!TOURNAMENT_ID_PATTERN.test(id)) {
      return 'Lettres minuscules, chiffres et tirets uniquement (ex : coupe-automne-2026)';
    }
    return null;
  }

  get previewUrl(): string {
    return `${location.origin}/tournaments/${this.id.trim() || '…'}`;
  }

  get currentStep(): WizardStep {
    const steps = this.steps;
    return steps[Math.min(this.stepIndex, steps.length - 1)];
  }

  get stepNumber(): number {
    return Math.min(this.stepIndex, this.steps.length - 1) + 1;
  }

  get stepCount(): number {
    return this.steps.length;
  }

  modeLabel(mode: TournamentMode): string {
    switch (mode) {
      case 'ladder':
        return 'Défi libre (ladder)';
      case 'swiss':
        return 'Rondes suisses';
      case 'swiss_with_challenge':
        return 'Rondes suisses avec défis en 1ère ronde';
      case 'pools_knockout':
        return 'Poules puis élimination directe';
    }
  }

  canGoNext(): boolean {
    switch (this.currentStep) {
      case 'name':
        return this.name.trim().length > 0 && this.organizerCoachName.trim().length > 0 && !this.idError;
      case 'rounds':
        return this.roundCount >= this.minRoundCount && this.roundCount <= this.maxRoundCount;
      case 'squad-size':
        return this.squadSize >= this.minSquadSize && this.squadSize <= this.maxSquadSize;
      case 'pools':
        return (
          this.poolSize >= this.minPoolSize &&
          this.poolSize <= this.maxPoolSize &&
          this.poolRoundCount >= this.minRoundCount &&
          this.poolRoundCount <= this.maxRoundCount &&
          this.qualifiersPerPool >= this.minQualifiersPerPool &&
          this.qualifiersPerPool < this.poolSize
        );
      default:
        return true;
    }
  }

  next(): void {
    if (!this.canGoNext()) return;
    this.stepIndex = Math.min(this.stepIndex + 1, this.steps.length - 1);
  }

  back(): void {
    this.stepIndex = Math.max(this.stepIndex - 1, 0);
  }

  async create(): Promise<void> {
    const name = this.name.trim();
    if (!name) return;
    this.busy = true;
    this.error = null;
    try {
      const res = await this.api.createTournament({
        name,
        organizerCoachName: this.organizerCoachName.trim(),
        id: this.id.trim(),
        requireRosterValidation: this.requireRosterValidation,
        requireResultConfirmation: this.requireResultConfirmation,
        format: this.format,
        mode: this.format === 'individual' ? this.mode : undefined,
        roundCount: this.needsRoundCount ? this.roundCount : undefined,
        squadSize: this.format === 'team' ? this.squadSize : undefined,
        poolSize: this.isPoolsKnockout ? this.poolSize : undefined,
        poolRoundCount: this.isPoolsKnockout ? this.poolRoundCount : undefined,
        qualifiersPerPool: this.isPoolsKnockout ? this.qualifiersPerPool : undefined,
      });
      this.createdTournamentId = res.tournamentId;
      this.createdAdminToken = res.adminToken;
      this.createdAdminLink = adminUrl(res.tournamentId, res.adminToken);
    } catch (err) {
      this.error = extractErrorMessage(err);
    } finally {
      this.busy = false;
    }
  }

  get isPoolsKnockout(): boolean {
    return this.format === 'individual' && this.mode === 'pools_knockout';
  }

  /**
   * Team format is always multi-round; individual format only needs roundCount outside ladder.
   * pools_knockout has its own roundCount-equivalent (poolRoundCount) sent separately — its total
   * round count isn't known upfront, so plain roundCount stays unset for it.
   */
  get needsRoundCount(): boolean {
    return this.format === 'team' || (this.mode !== 'ladder' && this.mode !== 'pools_knockout');
  }

  goToScoreboard(): void {
    if (this.createdTournamentId) {
      this.router.navigate(['/tournaments', this.createdTournamentId]);
    }
  }

  goToAdmin(): void {
    if (this.createdTournamentId && this.createdAdminToken) {
      // Not a query param: it must not end up in the URL the admin is about to bookmark.
      this.router.navigate(['/tournaments', this.createdTournamentId, 'admin', this.createdAdminToken], {
        state: { justCreated: true },
      });
    }
  }

  joinExisting(): void {
    const raw = this.joinTournamentId.trim();
    if (!raw) return;
    let id = raw;
    try {
      // Accept a full scoreboard/admin URL, extracting the id right after "/tournaments/".
      const segments = new URL(raw).pathname.split('/').filter(Boolean);
      const index = segments.indexOf('tournaments');
      if (index !== -1 && segments[index + 1]) id = segments[index + 1];
    } catch {
      // Not a URL — treat the raw input as the id itself (works for both legacy UUIDs and slugs).
    }
    this.router.navigate(['/tournaments', id]);
  }

  async copyAdminLink(): Promise<void> {
    if (!this.createdAdminLink) return;
    this.copied = await copyToClipboard(this.createdAdminLink);
  }
}
