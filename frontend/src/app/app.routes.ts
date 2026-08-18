import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { ScoreboardComponent } from './pages/scoreboard/scoreboard.component';
import { TeamDashboardComponent } from './pages/team-dashboard/team-dashboard.component';
import { AdminDashboardComponent } from './pages/admin-dashboard/admin-dashboard.component';

export const routes: Routes = [
  { path: '', component: HomeComponent },
  { path: 'tournaments/:tournamentId', component: ScoreboardComponent },
  { path: 'tournaments/:tournamentId/team/:teamId/:password', component: TeamDashboardComponent },
  { path: 'tournaments/:tournamentId/admin/:token', component: AdminDashboardComponent },
  { path: '**', redirectTo: '' },
];
