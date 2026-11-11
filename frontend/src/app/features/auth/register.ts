import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { isoToLegacy } from '../../core/domain/dates';
import { RegistrationRequest } from '../../core/models';

type RegisterForm = Omit<RegistrationRequest, 'dob'> & { dobIso: string };

@Component({
  selector: 'app-register',
  imports: [FormsModule, RouterLink],
  templateUrl: './register.html',
  styleUrl: './register.scss',
})
export class Register {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly model = signal<RegisterForm>({ name: '', mobile: '', email: '', gender: '', dobIso: '', aadhar: '', address: '' });
  protected readonly result = signal<{ username: string; setPasswordUrl?: string } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly submitting = signal(false);

  protected update<K extends keyof RegisterForm>(key: K, value: RegisterForm[K]): void {
    this.model.update((m) => ({ ...m, [key]: value }));
  }

  protected get isValid(): boolean {
    const m = this.model();
    return m.name.trim().length > 1 && /^[6-9]\d{9}$/.test(m.mobile) && /.+@.+\..+/.test(m.email);
  }

  protected submit(): void {
    if (!this.isValid) {
      return;
    }
    const m = this.model();
    this.submitting.set(true);
    this.error.set(null);
    this.auth
      .register({ name: m.name, mobile: m.mobile, email: m.email, gender: m.gender, dob: isoToLegacy(m.dobIso), aadhar: m.aadhar, address: m.address })
      .subscribe((r) => {
        this.submitting.set(false);
        if (r.success && r.username) {
          this.result.set({ username: r.username, setPasswordUrl: r.setPasswordUrl });
        } else {
          this.error.set(r.error ?? 'Registration failed.');
        }
      });
  }

  protected backToLogin(): void {
    this.router.navigate(['/auth/login']);
  }
}
