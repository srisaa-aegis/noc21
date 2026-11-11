import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IconComponent } from '../shared/ui/icon';

@Component({
  selector: 'app-auth-shell',
  imports: [RouterOutlet, IconComponent],
  templateUrl: './auth-shell.html',
  styleUrl: './auth-shell.scss',
})
export class AuthShell {}
