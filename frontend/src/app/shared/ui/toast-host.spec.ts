import { TestBed } from '@angular/core/testing';
import { ToastHost } from './toast-host';
import { ToastService } from './toast.service';

describe('ToastHost', () => {
  it('renders toasts pushed through ToastService', () => {
    TestBed.configureTestingModule({ imports: [ToastHost] });
    const fixture = TestBed.createComponent(ToastHost);
    const toastService = TestBed.inject(ToastService);
    toastService.success('Saved successfully');
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Saved successfully');
  });
});
