import { HttpClientTestingModule } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { PortalHeader } from './portal-header';

describe('PortalHeader', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PortalHeader, HttpClientTestingModule],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the portal label and nav links', () => {
    const fixture = TestBed.createComponent(PortalHeader);
    fixture.componentRef.setInput('portalLabel', 'Citizen Portal');
    fixture.componentRef.setInput('navLinks', [{ label: 'Dashboard', path: '/citizen/dashboard', icon: 'home' }]);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Citizen Portal');
    expect(text).toContain('Dashboard');
  });

  it('puts Change password and Logout in a menu behind the user name', () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen', undefined, 'Mantri Constructions');
    const fixture = TestBed.createComponent(PortalHeader);
    fixture.componentRef.setInput('portalLabel', 'Citizen Portal');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const trigger = el.querySelector<HTMLButtonElement>('.user-menu__trigger')!;
    expect(trigger.textContent).toContain('Mantri Constructions');
    expect(el.querySelector('.user-menu__avatar')?.textContent?.trim()).toBe('MC');
    expect(el.textContent).not.toContain('Logout');
    trigger.click();
    fixture.detectChanges();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(el.querySelectorAll('[role="menuitem"]')).map((i) => i.textContent?.trim());
    expect(items).toEqual(['Change password', 'Logout']);
    expect(el.querySelector('a[role="menuitem"]')?.getAttribute('href')).toBe('/citizen/change-password');
    document.dispatchEvent(new Event('click'));
    fixture.detectChanges();
    expect(el.querySelector('[role="menu"]')).toBeNull();
    resetBrowserState();
  });
});
