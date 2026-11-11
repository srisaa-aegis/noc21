import { Component, inject } from '@angular/core';
import { ConfirmDialogService } from './confirm-dialog.service';

@Component({
  selector: 'app-confirm-dialog-host',
  templateUrl: './confirm-dialog-host.html',
  styleUrl: './confirm-dialog-host.scss',
})
export class ConfirmDialogHost {
  protected readonly dialog = inject(ConfirmDialogService);
}
