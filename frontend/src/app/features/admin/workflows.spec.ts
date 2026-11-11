import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState } from '../../../testing/session';
import { Workflows } from './workflows';

describe('Workflows (admin matrix)', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [Workflows], providers: [provideRouter([]), provideFixtureBackend()] }).compileComponents();
  });

  it('shows one card per application type × approval level with the decision role and usage', async () => {
    const fixture = TestBed.createComponent(Workflows);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const cards = Array.from(el.querySelectorAll('a.wf-card'));
    expect(cards.length).toBe(12);
    expect(el.querySelector('.banner--error')).toBeNull();
    const card = (id: string) => cards.find((c) => c.getAttribute('href') === `/admin/workflows/${id}`)!.textContent!;
    expect(card('P-MSB')).toContain('Decided by DG');
    expect(card('P-MSB')).toContain('3 in parallel');
    expect(card('R-MSB')).toContain('Decided by DFS');
    expect(card('O-RFO')).toContain('Decided by RFO');
    expect(card('O-MSB')).toContain('2 in process');
  });
});
