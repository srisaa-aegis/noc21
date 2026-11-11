import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { provideFixtureBackend } from '../../../../testing/fixture-backend';
import { resetBrowserState, seedSession } from '../../../../testing/session';
import { ApplicationsService } from '../applications.service';
import { ConfirmApplication } from './confirm-application';

describe('ConfirmApplication (legacy confirmpnoc — confirmation before submission)', () => {
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    resetBrowserState();
    seedSession('citizen1', 'citizen');
    await TestBed.configureTestingModule({
      imports: [ConfirmApplication],
      providers: [provideRouter([]), provideFixtureBackend()],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => resetBrowserState());

  async function settle(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  /** Makes draft 104 complete and submittable. */
  async function completeDraft() {
    const service = TestBed.inject(ApplicationsService);
    const a = await firstValueFrom(service.get(104));
    a.lic_auth = 'Commissioner, VMC';
    a.lic_addr = 'VMC Office';
    a.perimeter = 260;
    a.blocks[0].ffe.agree_reqt = true;
    a.declaration_accepted = true;
    a.payment = { ...a.payment, mode: 'online', status: 'paid', amount: 35000, txn_ref: 'PAYU1', paid_on: '01-Nov-2026' };
    a.documents = ['Undertaking', 'BankGuarantee', 'SelfDeclaration', 'FFEEstimate', 'SitePlan:1', 'SectionPlan:1', 'ElevationPlan:1', ...a.blocks[0].floors.map((f) => `FloorPlan:1:${f.floor_id}`)].map(
      (code, i) => ({ doc_id: i + 1, code, file_name: `${code}.pdf`, category: code, uploaded_on: '01-Nov-2026' }),
    );
    await firstValueFrom(service.save(a));
  }

  async function open() {
    const fixture = TestBed.createComponent(ConfirmApplication);
    fixture.componentRef.setInput('id', '104');
    await settle(fixture);
    return fixture;
  }

  it('sends the applicant back when the application still has problems', async () => {
    const fixture = await open();
    expect(fixture.nativeElement.textContent).toContain('must be corrected before this application can be submitted');
    expect(fixture.nativeElement.querySelector('app-application-sheet')).toBeNull();
  });

  it('shows the whole application on one page and submits after all undertakings are ticked', async () => {
    await completeDraft();
    const fixture = await open();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Confirmation before Submission');
    expect(el.textContent).toContain('General Information');
    expect(el.textContent).toContain('Technical Staff of the Building');
    expect(el.textContent).toContain('Block: Block A');
    expect(el.textContent).toContain('Open Spaces Required & Proposed');
    expect(el.textContent).toContain('Means of Escape Required & Proposed');
    expect(el.textContent).toContain('Minimum required Fire Safety Systems');
    expect(el.textContent).toContain('Undertaking by Applicant');
    const confirm = Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes('Confirm & Submit')) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    const boxes = el.querySelectorAll<HTMLInputElement>('.undertaking input[type="checkbox"]');
    expect(boxes.length).toBe(6);
    boxes.forEach((b) => b.click());
    fixture.detectChanges();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await settle(fixture);
    const saved = await firstValueFrom(TestBed.inject(ApplicationsService).get(104));
    expect(saved.status_id).toBe(2);
    expect(saved.appl_number).toMatch(/^\d{11}$/); // yyyymm + 5 digits (N-2)
    expect(navigate).toHaveBeenCalledWith(['/citizen/applications', 104, 'print', 'acknowledgement']);
  });
});
