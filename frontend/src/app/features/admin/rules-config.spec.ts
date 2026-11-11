import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { LookupService } from '../../core/lookups/lookup.service';
import { provideFixtureBackend } from '../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../testing/session';
import { RulesConfig } from './rules-config';

describe('RulesConfig (admin: fees, approval levels, renewal periods)', () => {
  beforeEach(async () => {
    resetBrowserState();
    seedSession('admin', 'admin');
    await TestBed.configureTestingModule({
      imports: [RulesConfig],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  async function render() {
    const fixture = TestBed.createComponent(RulesConfig);
    for (let i = 0; i < 4; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
    }
    return fixture;
  }

  const config = () => firstValueFrom(TestBed.inject(LookupService).config());
  const button = (el: HTMLElement, text: string) => Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  const type = (el: HTMLElement, selector: string, value: string) => {
    const i = el.querySelector<HTMLInputElement>(selector)!;
    i.value = value;
    i.dispatchEvent(new Event('input'));
  };

  it('edits and saves the fee rates; the preview follows the edits', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Rs. 10,000'); // preview: 1000 sq.m Provisional
    type(el, '#rate-p', '12');
    type(el, '#portal', '500');
    fixture.detectChanges();
    expect(el.textContent).toContain('Rs. 12,000');
    button(el, 'Save Fees').click();
    await fixture.whenStable();
    const c = await config();
    expect(c.feeConfig.rates_per_sqm.P).toBe(12);
    expect(c.feeConfig.portal_charges).toBe(500);
  });

  it('refuses to save invalid fees', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    type(el, '#decl', '-5');
    fixture.detectChanges();
    button(el, 'Save Fees').click();
    fixture.detectChanges();
    expect(el.querySelector('.banner--error')?.textContent).toContain('Declaration fee must be zero or more');
    expect((await config()).feeConfig.declaration_fee).toBe(2000);
  });

  it('edits the ordered approval level rules and tests them', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Approval Levels').click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.rules-table tbody tr').length).toBe(7);
    // tester: residential A4, 18 m → HQ (rule 3)
    expect(el.querySelector('.tester__result')?.textContent).toContain('Head Office (DGFS / MSB)');
    expect(el.querySelector('.tester__result')?.textContent).toContain('rule 3');
    // raise the A4 HQ threshold to 21 m
    type(el, 'input[aria-label="Rule 3 minimum height"]', '21');
    fixture.detectChanges();
    expect(el.querySelector('.tester__result')?.textContent).toContain('Regional Fire Officer');
    button(el, 'Save Approval Levels').click();
    await fixture.whenStable();
    expect((await config()).delegationRules[2].min_height).toBe(21);
  });

  it('adds a rule before the catch-all and can move / remove it', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Approval Levels').click();
    fixture.detectChanges();
    button(el, 'Add rule').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const rows = el.querySelectorAll('.rules-table tbody tr');
    expect(rows.length).toBe(8);
    expect((rows[6].querySelector('input') as HTMLInputElement).value).toBe('New rule');
    (el.querySelector('button[aria-label="Remove rule 7"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.rules-table tbody tr').length).toBe(7);
  });

  it('has the multiplex rule as configuration (legacy MSB.rule) and tests it', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Approval Levels').click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((el.querySelector('input[aria-label="Rule 2 multiplex only"]') as HTMLInputElement).checked).toBe(true);
    const selects = el.querySelectorAll<HTMLSelectElement>('.tester select');
    selects[0].value = 'asm';
    selects[0].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    selects[1].value = 'D6';
    selects[1].dispatchEvent(new Event('change'));
    type(el, 'input[aria-label="Height in metres"]', '8');
    fixture.detectChanges();
    expect(el.querySelector('.tester__result')?.textContent).toContain('District Fire Officer');
    el.querySelector<HTMLInputElement>('input[aria-label="Test block is a multiplex"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.tester__result')?.textContent).toContain('Head Office');
    expect(el.querySelector('.tester__result')?.textContent).toContain('rule 2');
  });

  it('edits the renewal periods', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    button(el, 'Renewal Periods').click();
    fixture.detectChanges();
    expect(el.querySelector('.tester__result')?.textContent).toContain('5 year(s)'); // A4 18 m
    type(el, 'input[aria-label="Renewal rule 1 years"]', '4');
    fixture.detectChanges();
    expect(el.querySelector('.tester__result')?.textContent).toContain('4 year(s)');
    button(el, 'Save Renewal Periods').click();
    await fixture.whenStable();
    expect((await config()).renewalRules[0].years).toBe(4);
  });
});
