import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState } from '../../../testing/session';
import { Search } from './search';

/** The search is debounced (setTimeout), which `whenStable` does not wait for. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Search (dept)', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({ imports: [Search], providers: [provideRouter([]), provideFakeApi()] }).compileComponents();
  });

  it('filters submitted applications by free text and never shows drafts', async () => {
    const fixture = TestBed.createComponent(Search);
    fixture.detectChanges();
    await wait(20);
    fixture.detectChanges();
    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text()).toContain('Padma Rekha Apartments');
    expect(text()).not.toContain('So So So House'); // draft

    fixture.componentInstance['query'].set('guntur');
    fixture.detectChanges();
    await wait(300);
    fixture.detectChanges();
    expect(TestBed.inject(FakeApi).calls('GET', /^\/applications$/).at(-1)!.query).toEqual(expect.objectContaining({ scope: 'dept', text: 'guntur' }));
    expect(text()).toContain('Sunrise Towers');
    expect(text()).not.toContain('Padma Rekha Apartments');
  });

  it('links every result to the department view of the application', async () => {
    const fixture = TestBed.createComponent(Search);
    fixture.detectChanges();
    await wait(20);
    fixture.detectChanges();
    const links = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody a')).map((a) => a.getAttribute('href'));
    expect(links).toContain('/dept/applications/109');
  });
});
