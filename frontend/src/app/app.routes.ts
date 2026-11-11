import { Routes, UrlMatchResult, UrlSegment } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { passwordChangeGuard } from './core/auth/password-change.guard';
import { portalGuard } from './core/auth/role.guard';
import { unsavedChangesGuard } from './core/auth/unsaved-changes.guard';

/** Matches the application form pages: `applications/:id/edit/:step` and `applications/:id/edit/blocks/:blockId/:blockStep`. */
export function applicationFormMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length < 4 || segments[0].path !== 'applications' || segments[2].path !== 'edit') return null;
  if (segments.length === 4) {
    return { consumed: segments, posParams: { id: segments[1], step: segments[3] } };
  }
  if (segments.length === 6 && segments[3].path === 'blocks') {
    return { consumed: segments, posParams: { id: segments[1], step: segments[3], blockId: segments[4], blockStep: segments[5] } };
  }
  return null;
}

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'auth/login' },

  {
    path: 'auth',
    loadComponent: () => import('./layout/auth-shell').then((m) => m.AuthShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'login' },
      { path: 'login', loadComponent: () => import('./features/auth/login').then((m) => m.Login) },
      { path: 'register', loadComponent: () => import('./features/auth/register').then((m) => m.Register) },
      {
        path: 'forgot-password',
        loadComponent: () => import('./features/auth/forgot-password').then((m) => m.ForgotPassword),
      },
      {
        path: 'reset-password',
        loadComponent: () => import('./features/auth/reset-password').then((m) => m.ResetPassword),
      },
    ],
  },

  {
    path: 'citizen',
    canActivate: [authGuard, portalGuard('citizen')],
    canActivateChild: [passwordChangeGuard],
    loadComponent: () => import('./layout/citizen-shell').then((m) => m.CitizenShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/citizen/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'applications/:id',
        loadComponent: () =>
          import('./features/citizen/application-detail').then((m) => m.ApplicationDetail),
      },
      {
        path: 'applications/:id/edit',
        pathMatch: 'full',
        redirectTo: 'applications/:id/edit/basic',
      },
      {
        // applications/:id/edit/:step  and  applications/:id/edit/blocks/:blockId/:blockStep — ONE route, so the
        // form component (and its unsaved working copy) is kept while moving between pages and block flows.
        matcher: applicationFormMatcher,
        loadComponent: () => import('./features/citizen/wizard/wizard').then((m) => m.Wizard),
        canDeactivate: [unsavedChangesGuard],
      },
      {
        path: 'applications/:id/confirm',
        loadComponent: () => import('./features/citizen/wizard/confirm-application').then((m) => m.ConfirmApplication),
      },
      {
        path: 'applications/:id/print/:doc',
        loadComponent: () =>
          import('./features/citizen/print/print-document').then((m) => m.PrintDocument),
      },
      { path: 'change-password', loadComponent: () => import('./features/account/change-password').then((m) => m.ChangePassword) },
    ],
  },

  {
    path: 'dept',
    canActivate: [authGuard, portalGuard('dept')],
    canActivateChild: [passwordChangeGuard],
    loadComponent: () => import('./layout/dept-shell').then((m) => m.DeptShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dept/dashboard').then((m) => m.Dashboard),
      },
      { path: 'search', loadComponent: () => import('./features/dept/search').then((m) => m.Search) },
      {
        path: 'applications/:id',
        loadComponent: () => import('./features/dept/application-view').then((m) => m.ApplicationView),
      },
      { path: 'reports', pathMatch: 'full', redirectTo: 'reports/pendency' },
      { path: 'reports/:report', loadComponent: () => import('./features/dept/reports/reports').then((m) => m.Reports) },
      // the DG reads the audit trail (the server refuses everyone else)
      { path: 'audit', loadComponent: () => import('./features/admin/audit').then((m) => m.AdminAudit) },
      { path: 'change-password', loadComponent: () => import('./features/account/change-password').then((m) => m.ChangePassword) },
    ],
  },

  {
    path: 'admin',
    canActivate: [authGuard, portalGuard('admin')],
    canActivateChild: [passwordChangeGuard],
    loadComponent: () => import('./layout/admin-shell').then((m) => m.AdminShell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/admin/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'applications',
        loadComponent: () => import('./features/admin/applications').then((m) => m.AdminApplications),
      },
      {
        path: 'citizens',
        loadComponent: () => import('./features/admin/citizen-accounts').then((m) => m.CitizenAccounts),
      },
      {
        path: 'dept-users',
        loadComponent: () => import('./features/admin/dept-users').then((m) => m.DeptUsers),
      },
      { path: 'rules', loadComponent: () => import('./features/admin/rules-config').then((m) => m.RulesConfig) },
      { path: 'workflows', loadComponent: () => import('./features/admin/workflows').then((m) => m.Workflows) },
      {
        path: 'workflows/:id',
        loadComponent: () => import('./features/admin/workflow-editor').then((m) => m.WorkflowEditor),
        canDeactivate: [unsavedChangesGuard],
      },
      { path: 'sla', loadComponent: () => import('./features/admin/sla-config').then((m) => m.SlaConfigPage) },
      { path: 'statuses', loadComponent: () => import('./features/admin/statuses').then((m) => m.AdminStatuses) },
      { path: 'audit', loadComponent: () => import('./features/admin/audit').then((m) => m.AdminAudit) },
      { path: 'change-password', loadComponent: () => import('./features/account/change-password').then((m) => m.ChangePassword) },
    ],
  },

  { path: '**', redirectTo: 'auth/login' },
];
