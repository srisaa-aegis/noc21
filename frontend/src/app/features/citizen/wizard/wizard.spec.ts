import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideFixtureBackend } from '../../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { ConfirmDialogService } from '../../../shared/ui/confirm-dialog.service';
import { ToastService } from '../../../shared/ui/toast.service';
import { Wizard } from './wizard';

describe('Wizard (application form)', () => {
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [Wizard],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo; // not implemented in jsdom
  });

  afterEach(() => resetBrowserState());

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
    fixture.detectChanges();
  }

  async function open(id: string, step: string, type?: string, blockId?: string, blockStep?: string) {
    const fixture = TestBed.createComponent(Wizard);
    fixture.componentRef.setInput('id', id);
    fixture.componentRef.setInput('step', step);
    if (type) fixture.componentRef.setInput('type', type);
    if (blockId) fixture.componentRef.setInput('blockId', blockId);
    if (blockStep) fixture.componentRef.setInput('blockStep', blockStep);
    await settle(fixture);
    return fixture;
  }

  const button = (el: HTMLElement, text: string) =>
    (Array.from(el.querySelectorAll('button')) as HTMLButtonElement[]).find((b) => b.textContent?.trim().startsWith(text))!;

  it('renders the 4 application pages and the Application page with validation messages shown immediately', async () => {
    const fixture = await open('104', 'basic');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.stepper__item').length).toBe(4);
    expect(el.querySelector('.block-flow')).toBeNull();
    expect(el.textContent).toContain('Provisional NOC application');
    expect(el.querySelector('#site_name')).toBeTruthy();
    expect(el.querySelector('#lic_auth')?.classList).toContain('is-invalid');
    expect(el.textContent).toContain('Licensing authority is required');
    expect(el.querySelector('.stepper__badge--err')?.textContent?.trim()).toBe('3');
  });

  it('never blocks moving between pages: Next saves and navigates even with errors', async () => {
    const fixture = await open('104', 'basic');
    navigate.mockClear();
    button(fixture.nativeElement, 'Next').click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', '104', 'edit', 'blocks'], { replaceUrl: false });
  });

  it('a new application is saved on the first Save once the site name and address are entered', async () => {
    const fixture = await open('new', 'basic', 'P');
    const el = fixture.nativeElement as HTMLElement;
    const toast = TestBed.inject(ToastService);
    const error = vi.spyOn(toast, 'error');
    expect(el.textContent).toContain('not saved yet');
    button(el, 'Save').click();
    await settle(fixture);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Site Name and Site Address'));

    const store = fixture.componentInstance['store'];
    store.set(store.app()!, 'site_name', 'Green Meadows');
    store.set(store.app()!, 'site_addr', 'Survey 12, Guntur');
    navigate.mockClear();
    button(el, 'Save').click();
    await settle(fixture);
    const id = store.app()!.appl_id;
    expect(id).toBeGreaterThan(114);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', String(id), 'edit', 'basic'], { replaceUrl: true });
  });

  it('lists the blocks with their status per page of the block flow', async () => {
    const fixture = await open('104', 'blocks');
    const el = fixture.nativeElement as HTMLElement;
    const cards = el.querySelectorAll('.block-card');
    expect(cards.length).toBe(1);
    expect(cards[0].textContent).toContain('Block A');
    expect(cards[0].textContent).toContain('1 item(s) to complete');
    const chips = Array.from(cards[0].querySelectorAll('.page-chip')).map((c) => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['1 Block Details', '2 Floors', '3 Means of Escape', '4 Fire Fighting Equipment 1', '5 Plans']);
    navigate.mockClear();
    (cards[0].querySelectorAll('.page-chip')[2] as HTMLButtonElement).click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', '104', 'edit', 'blocks', '1', 'escapes'], { replaceUrl: false });
  });

  it('runs the block flow: Block Details → Floors → Means of Escape → Fire Fighting Equipment → Plans → back to Blocks', async () => {
    const fixture = await open('104', 'blocks', undefined, '1', 'details');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.block-flow__title')?.textContent).toContain('Block A');
    expect(el.querySelector('.block-flow__title')?.textContent).toContain('Block 1 of 1');
    expect(Array.from(el.querySelectorAll('.block-stepper__label')).map((l) => l.textContent)).toEqual([
      'Block Details',
      'Floors',
      'Means of Escape',
      'Fire Fighting Equipment',
      'Plans',
    ]);
    expect(el.querySelector('#site_type')).toBeTruthy(); // details page
    expect(el.querySelector('app-step-floors')).toBeNull();
    navigate.mockClear();
    button(el, 'Next').click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', '104', 'edit', 'blocks', '1', 'floors'], { replaceUrl: false });

    fixture.componentRef.setInput('blockStep', 'ffe');
    await settle(fixture);
    expect(el.querySelector('app-step-ffe')).toBeTruthy();
    expect(el.querySelector('.banner--info')?.textContent).toContain('1 item(s) on this page');

    fixture.componentRef.setInput('blockStep', 'plans');
    await settle(fixture);
    navigate.mockClear();
    button(el, 'Finish block').click();
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', '104', 'edit', 'blocks'], { replaceUrl: false });
  });

  it('keeps a new (unsaved) application while moving into a block flow', async () => {
    const fixture = await open('new', 'blocks', 'P');
    const store = fixture.componentInstance['store'];
    store.app()!.blocks[0].block_name = 'Tower 9';
    fixture.componentRef.setInput('blockId', '1');
    fixture.componentRef.setInput('blockStep', 'details');
    await settle(fixture);
    expect(store.isNew()).toBe(true);
    expect(fixture.nativeElement.querySelector('.block-flow__title')?.textContent).toContain('Tower 9');
  });

  it('falls back to the block list for an unknown block', async () => {
    await open('104', 'blocks', undefined, '99', 'details');
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', '104', 'edit', 'blocks'], { replaceUrl: true });
  });

  it('renders a 3-page form without technical parties for a Declaration', async () => {
    const fixture = await open('new', 'basic', 'D');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.stepper__item').length).toBe(3);
    expect(el.textContent).not.toContain('Technical Personnel');
    expect(el.textContent).toContain('Occupancy NOC Reference');
  });

  it('shows the department remarks banner when editing a revision', async () => {
    const fixture = await open('104', 'basic');
    const store = fixture.componentInstance['store'];
    const app = store.app()!;
    app.revision = 2;
    app.processLog.push({ step_id: 9, uid: 1, reviewer_name: 'RFO', role: 'RFO', status_id: 8, action: 'Returned', remarks: 'Fix the setbacks', at_date: '01-Jan-2026' });
    store.touch();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.banner--warning')?.textContent).toContain('Fix the setbacks');
  });

  it('asks before leaving with unsaved changes', async () => {
    const fixture = await open('104', 'basic');
    const store = fixture.componentInstance['store'];
    expect(await fixture.componentInstance.canLeave('/citizen/dashboard')).toBe(true);
    store.set(store.app()!, 'lic_auth', 'x');
    const dialog = TestBed.inject(ConfirmDialogService);
    const leaving = fixture.componentInstance.canLeave('/citizen/dashboard');
    expect(dialog.state()?.title).toBe('Leave without saving?');
    dialog.respond(false);
    expect(await leaving).toBe(false);
    expect(await fixture.componentInstance.canLeave('/citizen/applications/104/edit/blocks')).toBe(true); // same form
  });

  it('shows a message instead of the form for a submitted application', async () => {
    const fixture = await open('102', 'basic');
    expect(fixture.nativeElement.textContent).toContain('can no longer be edited');
  });
});
