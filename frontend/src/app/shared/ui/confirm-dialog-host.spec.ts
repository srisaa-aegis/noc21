import { TestBed } from '@angular/core/testing';
import { ConfirmDialogHost } from './confirm-dialog-host';
import { ConfirmDialogService } from './confirm-dialog.service';

describe('ConfirmDialogHost', () => {
  it('renders nothing when no dialog is open', () => {
    const fixture = TestBed.createComponent(ConfirmDialogHost);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.dialog')).toBeNull();
  });

  it('renders the dialog and resolves true on confirm', async () => {
    const fixture = TestBed.createComponent(ConfirmDialogHost);
    const dialogService = TestBed.inject(ConfirmDialogService);

    const resultPromise = dialogService.open({ title: 'Delete draft?', message: 'This cannot be undone.' });
    fixture.detectChanges();

    const confirmButton = (fixture.nativeElement as HTMLElement).querySelector(
      '.btn--primary',
    ) as HTMLButtonElement;
    confirmButton.click();

    expect(await resultPromise).toBe(true);
  });
});
