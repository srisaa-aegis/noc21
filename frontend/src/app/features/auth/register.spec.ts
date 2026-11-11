import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { FakeApi, provideFakeApi } from '../../../testing/fake-api';
import { resetBrowserState } from '../../../testing/session';
import { Register } from './register';

describe('Register', () => {
  beforeEach(async () => {
    resetBrowserState();
    await TestBed.configureTestingModule({
      imports: [Register],
      providers: [provideRouter([]), provideFakeApi()],
    }).compileComponents();
  });

  afterEach(() => resetBrowserState());

  it('disables submit until valid, then creates the account and explains the e-mailed "set your password" link', async () => {
    const fixture = TestBed.createComponent(Register);
    fixture.detectChanges();
    const button = () => fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    fixture.componentInstance['update']('name', 'Jane Builder');
    fixture.componentInstance['update']('mobile', '9876543210');
    fixture.componentInstance['update']('email', 'jane@example.com');
    fixture.detectChanges();
    expect(button().disabled).toBe(false);

    button().click();
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Registration successful');
    expect(text).toContain('jane@example.com');
    expect(text).toContain('choose your password');
    expect(fixture.nativeElement.querySelector('.dev-link a')?.getAttribute('href')).toContain('/auth/reset-password?token=');
    expect(TestBed.inject(FakeApi).calls('POST', /^\/auth\/register$/)[0].body).toEqual(expect.objectContaining({ email: 'jane@example.com', name: 'Jane Builder' }));
  });

  it('shows an error for an e-mail that is already registered', async () => {
    const fixture = TestBed.createComponent(Register);
    fixture.componentInstance['update']('name', 'Dup');
    fixture.componentInstance['update']('mobile', '9876543210');
    fixture.componentInstance['update']('email', 'builder1@example.com');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('already exists');
  });
});
