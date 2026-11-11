import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from './icon';

export interface PortalNavLink {
  label: string;
  path: string;
  icon: string;
}

/** Shared chrome (brand + nav + user menu) used by the citizen/dept/admin shells. */
@Component({
  selector: 'app-portal-header',
  imports: [RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './portal-header.html',
  styleUrl: './portal-header.scss',
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'closeMenu()',
  },
})
export class PortalHeader {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly portalLabel = input.required<string>();
  readonly navLinks = input<PortalNavLink[]>([]);

  protected readonly session = this.auth.session;

  /** User menu (name ▾ → Change password / Logout). */
  protected readonly menuOpen = signal(false);

  protected readonly initials = computed(() =>
    (this.session()?.displayName ?? '')
      .split(/\s+/)
      .filter((w) => /^[A-Za-z0-9]/.test(w))
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join(''),
  );

  protected toggleMenu(event: Event): void {
    event.stopPropagation();
    this.menuOpen.update((v) => !v);
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Closes the menu on a click anywhere outside it. */
  protected onDocumentClick(event: Event): void {
    const menu = this.host.nativeElement.querySelector('.user-menu');
    if (menu && event.target instanceof Node && menu.contains(event.target)) return;
    this.closeMenu();
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected logout(): void {
    this.menuOpen.set(false);
    this.auth.logout();
    this.router.navigateByUrl('/auth/login');
  }
}
