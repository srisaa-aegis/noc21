export class RuleEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RuleEngineError';
  }
}

export class RuleSetNotFoundError extends RuleEngineError {
  constructor(code: string) {
    super(`No published version of rule set "${code}".`, 'rule_set_not_found', { code });
    this.name = 'RuleSetNotFoundError';
  }
}

export class RuleDefinitionError extends RuleEngineError {
  constructor(code: string, problems: { path: string; message: string }[]) {
    super(`Rule set "${code}" is not valid: ${problems.map((p) => `${p.path}: ${p.message}`).join(' ')}`, 'rule_definition_invalid', problems);
    this.name = 'RuleDefinitionError';
  }
}
