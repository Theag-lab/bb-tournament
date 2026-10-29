import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { fumbblMatchUrl, fumbblSpectateUrl, type FumbblMatchLink } from '@bb-tournament/shared';

/**
 * Small FUMBBL badge for a tracked match (see FumbblMatchLink): "live" spectate link while the
 * game is being played, then a link to the finished match's FUMBBL page.
 */
@Component({
  selector: 'app-fumbbl-link',
  standalone: true,
  imports: [CommonModule],
  template: `
    <a
      *ngIf="link.state === 'live'"
      class="fumbbl-link fumbbl-live"
      [href]="spectateUrl"
      title="Match en cours sur FUMBBL — regarder"
      aria-label="Regarder le match en cours sur FUMBBL"
      ><span class="dot" aria-hidden="true"></span>FUMBBL</a
    >
    <a
      *ngIf="link.state === 'finished' && link.matchId !== null"
      class="fumbbl-link"
      [href]="matchUrl"
      target="_blank"
      rel="noopener"
      title="Voir le match sur FUMBBL"
      aria-label="Voir le match sur FUMBBL"
      >FUMBBL</a
    >
  `,
  styles: `
    .fumbbl-link {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.05rem 0.45rem;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--text-muted);
      text-decoration: none;
      white-space: nowrap;
      vertical-align: middle;

      &:hover {
        border-color: var(--primary);
        color: var(--text);
      }
    }

    .fumbbl-live {
      color: var(--text);
      border-color: var(--primary);
    }

    .dot {
      width: 0.45rem;
      height: 0.45rem;
      border-radius: 50%;
      background: var(--primary);
      animation: pulse 1.6s ease-in-out infinite;
    }

    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .dot {
        animation: none;
      }
    }
  `,
})
export class FumbblLinkComponent {
  @Input({ required: true }) link!: FumbblMatchLink;

  get spectateUrl(): string {
    return fumbblSpectateUrl(this.link.liveGameId);
  }

  get matchUrl(): string {
    return fumbblMatchUrl(this.link.matchId!);
  }
}
