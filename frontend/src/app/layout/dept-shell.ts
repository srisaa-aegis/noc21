import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth/auth.service';
import { LookupService } from '../core/lookups/lookup.service';
import { PortalHeader, PortalNavLink } from '../shared/ui/portal-header';

@Component({
  selector: 'app-dept-shell',
  imports: [RouterOutlet, PortalHeader],
  templateUrl: './dept-shell.html',
  styleUrl: './dept-shell.scss',
})
export class DeptShell {
  private readonly session = inject(AuthService).session;
  private readonly roles = toSignal(inject(LookupService).deptRoles$, { initialValue: [] });

  /** The DG also reads the audit trail (with the administrator). */
  private readonly isDg = computed(() => this.roles().find((r) => r.id === this.session()?.role_id)?.code === 'DG');

  protected readonly navLinks = computed<PortalNavLink[]>(() => [
    { label: 'Dashboard', path: '/dept/dashboard', icon: 'home' },
    { label: 'Search', path: '/dept/search', icon: 'search' },
    { label: 'Reports', path: '/dept/reports', icon: 'bar-chart' },
    ...(this.isDg() ? [{ label: 'Audit', path: '/dept/audit', icon: 'clock' }] : []),
  ]);
}
