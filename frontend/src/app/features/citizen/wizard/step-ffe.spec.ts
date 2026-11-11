import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideFixtureBackend } from '../../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { ApplicationDraftStore } from './application-draft.store';
import { StepFfe } from './step-ffe';

describe('StepFfe (legacy editpnoc_3 / editonoc_3)', () => {
  let store: ApplicationDraftStore;

  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [StepFfe],
      providers: [ApplicationDraftStore, provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
    store = TestBed.inject(ApplicationDraftStore);
    await store.load('104', 'citizen1');
  });

  afterEach(() => resetBrowserState());

  function render() {
    const fixture = TestBed.createComponent(StepFfe);
    fixture.componentRef.setInput('index', 0);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the minimum required systems and the floor-wise grid (read-only for a Provisional NOC)', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.textContent).toContain('Minimum required Fire Safety Systems');
    expect(el.textContent).toContain('Floor-wise Fire Safety Systems');
    const summary = el.querySelector('table.ffe-summary')!;
    expect(summary.textContent).toContain('Fire Extinguishers');
    expect(summary.textContent).toContain('35 Nos.'); // 5 floors × 7
    const grid = el.querySelector('table.ffe-grid')!;
    expect(grid.querySelectorAll('tbody tr').length).toBe(6); // 5 floors + Total / Building
    expect(grid.querySelectorAll('input').length).toBe(0);
    expect(el.textContent).toContain('I confirm that the construction shall adhere to the minimum quantities');
  });

  it('records the confirmation tick', () => {
    const fixture = render();
    const box = fixture.nativeElement.querySelector('.agree input') as HTMLInputElement;
    box.click();
    fixture.detectChanges();
    expect(store.app()!.blocks[0].ffe.agree_reqt).toBe(true);
    expect(store.fieldError('blocks.0.ffe.agree_reqt')).toBeNull();
  });

  it('has "Provided" inputs for an Occupancy NOC; entering a value updates the grid totals', () => {
    const a = store.app()!;
    a.appl_type = 'O';
    a.appl_mode = 'N';
    store.touch();
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const inputs = el.querySelectorAll<HTMLInputElement>('table.ffe-grid input');
    expect(inputs.length).toBeGreaterThan(0);
    expect(el.textContent).toContain('Add Fire Fighting Equipment');
    const first = el.querySelector<HTMLInputElement>('input[aria-label="Fire Ext. Provided — Ground"]')!;
    first.value = '7';
    first.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const ext = store.app()!.blocks[0].ffe.items.find((i) => i.equip_id === 2)!;
    expect(ext.floors['1'].prov).toBe(7);
    expect(store.saveState()).toBe('dirty');
  });

  it('toggles the NBC Table 7 reference', async () => {
    const fixture = render();
    const el = fixture.nativeElement as HTMLElement;
    const btn = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Show Table 7'))!;
    btn.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.table7__body')?.textContent).toContain('Minimum Requirements for Fire Fighting Installations');
  });
});
