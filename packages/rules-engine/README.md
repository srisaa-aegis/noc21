# @srisaa/rules-engine

A generic, versioned rules engine. It has **no business-domain knowledge**, no runtime
dependencies, and no Node-only APIs, so it runs on a server and in a browser.

Copyright (c) Srisaa Technologies Private Limited. MIT licensed.

## Rule kinds

| Kind | What it is |
|---|---|
| `decision_tree` | Nodes that test a fact and either `goto` another node or `return` a value. This is the format of the legacy `*.rule` files, supported verbatim (`EQ, DEF, GT, GE, LT, LE, BR, BL`). |
| `decision_table` | Ordered rows of conditions (`in`, `notIn`, `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `between`, `isTrue`, `isFalse`, `any`) producing an output; hit policies `FIRST`, `PRIORITY`, `COLLECT`; optional aggregation across a collection of fact sets (`MAX_RANK`, `MIN`, `MAX`, `SUM`, `LIST`). |
| `parameters` | A versioned set of named constants. |

## Using it

```ts
import { RuleEngine } from '@srisaa/rules-engine';

const engine = new RuleEngine(source);           // source: RuleSetSource port
const { value, versionId, trace } = engine.evaluate('noc.height_limits', facts, { trace: true });
const level = engine.evaluateCollection('noc.approval_level', blocks).value;   // aggregated
const rate  = engine.parameter('noc.fees', 'portal_charges');
```

Every result reports the **version** that produced it, so a decision can be explained years
later. Published versions are immutable. `validateDefinition()` reports structural problems
(cycles, unreachable nodes, unknown operators, reserved fact names) and `runTestCases()`
replays stored regression cases before a new version is published.

## Ports

`RuleSetSource` — returns the published version of a rule set (from a database, a cache or
an in-memory map). `@srisaa/rules-engine/testing` ships `InMemoryRuleSetSource`.
