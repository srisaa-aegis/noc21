import { Component, input, output } from '@angular/core';

/**
 * Generic modal with projected body and footer:
 *   <app-modal [open]="x()" title="Edit" (closed)="x.set(false)">
 *     ...body...
 *     <div modal-footer>...buttons...</div>
 *   </app-modal>
 */
@Component({
  selector: 'app-modal',
  template: `
    @if (open()) {
      <div class="modal-backdrop" role="presentation" (click)="closed.emit()" (keydown.escape)="closed.emit()">
        <div
          class="modal"
          [class.modal--wide]="wide()"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-label]="title()"
          (click)="$event.stopPropagation()"
          (keydown.escape)="closed.emit()"
        >
          <header class="modal__header">
            <h3>{{ title() }}</h3>
            <button type="button" class="modal__close" aria-label="Close" (click)="closed.emit()">&times;</button>
          </header>
          <div class="modal__body"><ng-content></ng-content></div>
          <footer class="modal__footer"><ng-content select="[modal-footer]"></ng-content></footer>
        </div>
      </div>
    }
  `,
  styles: `
    .modal-backdrop { position: fixed; inset: 0; background: rgba(23, 26, 34, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1050; padding: var(--space-4); }
    .modal { background: var(--surface); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); width: 100%; max-width: 520px; max-height: 90vh; display: flex; flex-direction: column; }
    .modal--wide { max-width: 760px; }
    .modal__header { display: flex; align-items: center; justify-content: space-between; padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--border); }
    .modal__header h3 { margin: 0; }
    .modal__close { background: none; border: none; font-size: 1.5rem; line-height: 1; cursor: pointer; color: var(--gray-500); }
    .modal__body { padding: var(--space-5); overflow-y: auto; }
    .modal__footer { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-5); border-top: 1px solid var(--border); }
    .modal__footer:empty { display: none; }
  `,
})
export class Modal {
  readonly open = input(false);
  readonly title = input('');
  readonly wide = input(false);
  readonly closed = output<void>();
}
