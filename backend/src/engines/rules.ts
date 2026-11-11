/**
 * Wiring of @srisaa/rules-engine to the reference cache.
 *
 * The engine's RuleSetSource reads the `rules` bundle from memory, so every
 * calculation (FFE grid, fee, approval level, renewal period, validation) runs
 * without touching the database. When an admin publishes a new version the
 * bundle is rebuilt by NOTIFY and a fresh engine is handed out.
 */
import { RuleEngine, type RuleSetSource, type RuleSetVersion } from '@srisaa/rules-engine';
import type { ReferenceCache } from '../cache/reference-cache.js';
import type { RulesBundle } from '../cache/bundles.js';

class CachedRuleSetSource implements RuleSetSource {
  constructor(private readonly bundle: RulesBundle) {}

  getPublished(code: string): RuleSetVersion | undefined {
    const set = this.bundle.sets[code];
    if (!set) return undefined;
    return {
      versionId: set.versionId,
      ruleSetCode: code,
      kind: set.kind as RuleSetVersion['kind'],
      version: set.version,
      status: 'published',
      definition: set.definition as RuleSetVersion['definition'],
    };
  }

  getVersionById(versionId: number): RuleSetVersion | undefined {
    for (const code of Object.keys(this.bundle.sets)) {
      if (this.bundle.sets[code].versionId === versionId) return this.getPublished(code);
    }
    return undefined;
  }

  listCodes(): string[] {
    return Object.keys(this.bundle.sets);
  }
}

/** One engine per bundle version; rebuilt when the `rules` bundle changes. */
export class RulesEngineProvider {
  private cachedVersion = -1;
  private engine?: RuleEngine;

  constructor(private readonly cache: ReferenceCache) {}

  get(): RuleEngine {
    const bundle = this.cache.get('rules');
    if (!this.engine || this.cachedVersion !== bundle.version) {
      this.engine = new RuleEngine(new CachedRuleSetSource(bundle.data as RulesBundle));
      this.cachedVersion = bundle.version;
    }
    return this.engine;
  }
}
