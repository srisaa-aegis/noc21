import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PortalHeader, PortalNavLink } from '../shared/ui/portal-header';

@Component({
  selector: 'app-citizen-shell',
  imports: [RouterOutlet, PortalHeader],
  templateUrl: './citizen-shell.html',
  styleUrl: './citizen-shell.scss',
})
export class CitizenShell {
  protected readonly navLinks: PortalNavLink[] = [{ label: 'My Applications', path: '/citizen/dashboard', icon: 'home' }];
}
