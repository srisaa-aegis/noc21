import { Injectable, signal } from '@angular/core';

export interface ConfirmDialogOptions {
  title: string;
  message?: string;
  items?: string[];
  confirmText?: string;
  cancelText?: string;
  /** Hides the cancel button — used for purely informational dialogs. */
  infoOnly?: boolean;
}

export interface ConfirmDialogState extends ConfirmDialogOptions {
  resolve: (value: boolean) => void;
}

/**
 * Promise-based confirm/info dialog — replaces the legacy app's blocking
 * `window.confirm()` / Bootstrap modal instruction popups with one
 * reusable, accessible dialog rendered by <app-confirm-dialog-host>.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly stateSignal = signal<ConfirmDialogState | null>(null);
  readonly state = this.stateSignal.asReadonly();

  open(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.stateSignal.set({ ...options, resolve });
    });
  }

  respond(value: boolean): void {
    const current = this.stateSignal();
    if (!current) {
      return;
    }
    this.stateSignal.set(null);
    current.resolve(value);
  }
}
