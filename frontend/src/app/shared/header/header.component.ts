import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink, type ActivatedRouteSnapshot } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { renderMarkdown } from '../../core/markdown';
import { SITE_INFO_MARKDOWN } from '../../core/site-info';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private navigationSub?: Subscription;

  tournamentId: string | null = null;
  infoOpen = false;
  readonly infoHtml = renderMarkdown(SITE_INFO_MARKDOWN);

  openInfo(): void {
    this.infoOpen = true;
  }

  closeInfo(): void {
    this.infoOpen = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeInfo();
  }

  ngOnInit(): void {
    this.updateTournamentId();
    this.navigationSub = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.updateTournamentId());
  }

  ngOnDestroy(): void {
    this.navigationSub?.unsubscribe();
  }

  get brandLink(): unknown[] {
    return this.tournamentId ? ['/tournaments', this.tournamentId] : ['/'];
  }

  private updateTournamentId(): void {
    let route: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;
    let found: string | null = null;
    while (route) {
      found = route.paramMap.get('tournamentId') ?? found;
      route = route.firstChild;
    }
    this.tournamentId = found;
  }
}
