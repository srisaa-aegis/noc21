import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PortalHeader, PortalNavLink } from '../shared/ui/portal-header';

@Component({
  selector: 'app-admin-shell',
  imports: [RouterOutlet, PortalHeader],
  templateUrl: './admin-shell.html',
  styleUrl: './admin-shell.scss',
})
export class AdminShell {
  protected readonly navLinks: PortalNavLink[] = [
    { label: 'Workbench', path: '/admin/dashboard', icon: 'home' },
    { label: 'Applications', path: '/admin/applications', icon: 'search' },
    { label: 'Citizens', path: '/admin/citizens', icon: 'user' },
    { label: 'Dept Users', path: '/admin/dept-users', icon: 'users' },
    { label: 'Rules & Fees', path: '/admin/rules', icon: 'sliders' },
    { label: 'Workflows', path: '/admin/workflows', icon: 'layers' },
    { label: 'SLA', path: '/admin/sla', icon: 'clock' },
    { label: 'Statuses', path: '/admin/statuses', icon: 'list' },
    { label: 'Audit', path: '/admin/audit', icon: 'clock' },
  ];
}
