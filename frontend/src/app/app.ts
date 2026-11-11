import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmDialogHost } from './shared/ui/confirm-dialog-host';
import { ToastHost } from './shared/ui/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, ConfirmDialogHost],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
