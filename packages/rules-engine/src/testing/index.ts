/** Test helpers: an in-memory RuleSetSource for unit tests and fixtures. */
import type { RuleDefinition, RuleKind, RuleSetSource, RuleSetVersion } from '../types.js';

export class InMemoryRuleSetSource implements RuleSetSource {
  private readonly byCode = new Map<string, RuleSetVersion>();
  private readonly byId = new Map<number, RuleSetVersion>();
  private nextId = 1;

  add(code: string, kind: RuleKind, definition: RuleDefinition, version = 1): RuleSetVersion {
    const v: RuleSetVersion = {
      versionId: this.nextId++,
      ruleSetCode: code,
      kind,
      version,
      status: 'published',
      definition,
    };
    this.byCode.set(code, v);
    this.byId.set(v.versionId, v);
    return v;
  }

  getPublished(code: string): RuleSetVersion | undefined {
    return this.byCode.get(code);
  }

  getVersionById(versionId: number): RuleSetVersion | undefined {
    return this.byId.get(versionId);
  }

  listCodes(): string[] {
    return [...this.byCode.keys()];
  }
}
