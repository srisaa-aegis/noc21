import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Modal } from './modal';

@Component({
  imports: [Modal],
  template: `<app-modal [open]="open()" title="Edit account" (closed)="open.set(false)"><p>Body text</p><button modal-footer>Save</button></app-modal>`,
})
class Host {
  open = signal(true);
}

describe('Modal', () => {
  it('projects body and footer content and closes via the close button', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Edit account');
    expect(el.textContent).toContain('Body text');
    expect(el.querySelector('.modal__footer button')?.textContent).toContain('Save');

    (el.querySelector('.modal__close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('.modal')).toBeNull();
  });
});
