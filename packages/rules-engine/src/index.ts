/**
 * @srisaa/rules-engine
 * Copyright (c) Srisaa Technologies Private Limited. MIT licensed.
 *
 * A generic, versioned rules engine:
 *   - decision trees  (the legacy `*.rule` format, evaluated verbatim)
 *   - decision tables (ordered rows, hit policies, collection aggregation)
 *   - parameter sets  (versioned typed constants)
 * with explain traces, structural validation and stored regression cases.
 * It has no knowledge of any business domain and no runtime dependencies.
 */
export * from './types.js';
export * from './errors.js';
export { decisionMatches, evaluateTree, factName } from './tree.js';
export type { TreeEvaluation } from './tree.js';
export { conditionMatches, evaluateTable, evaluateTableCollection, rowMatches } from './table.js';
export type { TableCollectionEvaluation, TableEvaluation } from './table.js';
export { errorsOf, validateDecisionTable, validateDecisionTree, validateDefinition, validateParameters } from './validate.js';
export { compile, RuleEngine } from './engine.js';
export type { RuleEngineOptions } from './engine.js';
