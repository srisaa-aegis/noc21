import { Component, input, model } from '@angular/core';

/** 1–5 star rating (legacy feedback_rating / savefeedback): interactive, or read-only display. */
@Component({
  selector: 'app-star-rating',
  template: `
    <span class="stars" [class.is-readonly]="readonly()" role="radiogroup" [attr.aria-label]="label()">
      @for (s of stars; track s) {
        @if (readonly()) {
          <span class="star" [class.is-on]="s <= value()" aria-hidden="true">★</span>
        } @else {
          <button
            type="button"
            class="star"
            role="radio"
            [class.is-on]="s <= value()"
            [attr.aria-checked]="s === value()"
            [attr.aria-label]="s + (s === 1 ? ' star' : ' stars')"
            (click)="value.set(s)"
          >★</button>
        }
      }
      @if (readonly()) { <span class="sr-only">{{ value() }} out of 5 stars</span> }
    </span>
  `,
  styles: `
    .stars { display: inline-flex; gap: 2px; align-items: center; }
    .star { font-size: var(--star-size, 24px); line-height: 1; color: var(--gray-300, #cbd5e1); background: none; border: none; padding: 0 1px; cursor: pointer; }
    .is-readonly .star { cursor: default; font-size: var(--star-size, 16px); }
    .star.is-on { color: #f59e0b; }
    button.star:focus-visible { outline: 2px solid var(--brand-500); border-radius: 4px; }
    .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class StarRating {
  readonly value = model(0);
  readonly readonly = input(false);
  readonly label = input('Rating');
  protected readonly stars = [1, 2, 3, 4, 5];
}
