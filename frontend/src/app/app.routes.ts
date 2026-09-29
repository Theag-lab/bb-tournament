import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'tournaments/:tournamentId',
    loadComponent: () => import('./pages/scoreboard/scoreboard.component').then((m) => m.ScoreboardComponent),
  },
  {
    path: 'tournaments/:tournamentId/kiosk',
    loadComponent: () => import('./pages/kiosk/kiosk.component').then((m) => m.KioskComponent),
  },
  {
    path: 'tournaments/:tournamentId/team/:teamId/:password',
    loadComponent: () => import('./pages/team-dashboard/team-dashboard.component').then((m) => m.TeamDashboardComponent),
  },
  {
    path: 'tournaments/:tournamentId/admin/:token',
    loadComponent: () => import('./pages/admin-dashboard/admin-dashboard.component').then((m) => m.AdminDashboardComponent),
  },
  { path: '**', redirectTo: '' },
];
