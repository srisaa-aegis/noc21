import { CanDeactivateFn } from '@angular/router';

/** Components that may hold unsaved work implement this (e.g. the application form). */
export interface LeaveAware {
  canLeave(nextUrl: string): Promise<boolean> | boolean;
}

/** Asks the component whether the user may navigate away (legacy "unsaved changes" confirm). */
export const unsavedChangesGuard: CanDeactivateFn<LeaveAware> = (component, _route, _state, next) =>
  component?.canLeave ? component.canLeave(next.url) : true;
