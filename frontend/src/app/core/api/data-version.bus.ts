import { Injectable, signal } from '@angular/core';

export type BundleName = 'reference' | 'rules' | 'content' | 'workflow' | 'directory';
export const BUNDLE_NAMES: BundleName[] = ['reference', 'rules', 'content', 'workflow', 'directory'];

export type BundleVersions = Partial<Record<BundleName, number>>;

/**
 * Knows which version of each cached bundle the server currently serves.
 *
 * It is fed by the `X-Data-Versions` header of every API response (no polling),
 * and by the login / refresh payloads. `ReferenceDataStore` subscribes to it
 * and refetches only the bundles that moved.
 */
@Injectable({ providedIn: 'root' })
export class DataVersionBus {
  /** Versions the server reports. */
  readonly serverVersions = signal<BundleVersions>({});

  observe(header: string): void {
    const next: BundleVersions = {};
    for (const part of header.split(';')) {
      const [name, value] = part.split('=');
      if (BUNDLE_NAMES.includes(name as BundleName)) next[name as BundleName] = Number(value);
    }
    this.merge(next);
  }

  merge(versions: BundleVersions): void {
    const current = this.serverVersions();
    let changed = false;
    for (const name of BUNDLE_NAMES) {
      const v = versions[name];
      if (v !== undefined && current[name] !== v) changed = true;
    }
    if (changed) this.serverVersions.set({ ...current, ...versions });
  }
}
