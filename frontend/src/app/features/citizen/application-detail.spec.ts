import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { ApplicationDetail } from './application-detail';

describe('ApplicationDetail', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [ApplicationDetail],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function open(id: string) {
    const fixture = TestBed.createComponent(ApplicationDetail);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('renders details, parties, blocks, documents and the timeline', async () => {
    const fixture = await open('101');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Padma Rekha Apartments');
    expect(text).toContain('2016080001');
    expect(text).toContain('S. Architects & Associates');
    expect(text).toContain('Club House');
    expect(text).toContain('Undertaking on Rs. 100 Stamp Paper');
    expect(text).toContain('Provide signage and emergency lighting');
    expect(text).toContain('Download NOC');
    expect(text).toContain('Minimum required Fire Safety Systems');
    expect(text).toContain('Head Office (DGFS / MSB)');
  });

  it('shows the citizen rating and lets the citizen rate a completed application', async () => {
    const fixture = await open('111');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Display Certificate');
    expect(el.textContent).toContain('29-Jul-2022');
    const rate = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Rate this service'))!;
    rate.click();
    fixture.detectChanges();
    const dialog = el.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Rate our service');
    (dialog.querySelectorAll('button.star')[3] as HTMLButtonElement).click();
    const textarea = dialog.querySelector('textarea')!;
    textarea.value = 'Helpful staff';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Submit')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.feedback-strip')?.textContent).toContain('Helpful staff');
    expect(el.querySelectorAll('.feedback-strip .star.is-on').length).toBe(4);
  });

  it('does not offer rating for applications still in progress', async () => {
    const fixture = await open('102');
    expect(fixture.nativeElement.textContent).not.toContain('Rate this service');
  });

  it('offers the department document request upload', async () => {
    const fixture = await open('102');
    expect(fixture.nativeElement.querySelector('#requests')?.textContent).toContain('Municipal Completion Certificate');
  });

  it('shows "not found" for another citizen’s application', async () => {
    const fixture = await open('109');
    expect(fixture.nativeElement.textContent).toContain('Application not found');
  });
});
