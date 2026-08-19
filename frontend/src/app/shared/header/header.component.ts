import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { NavigationEnd, Router, RouterLink, type ActivatedRouteSnapshot } from '@angular/router';
import { Subscription, filter } from 'rxjs';

@Component({
  selector: 'app-header',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private navigationSub?: Subscription;

  tournamentId: string | null = null;

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
