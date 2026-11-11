/**
 * Structural validation of a process definition. Hosts add their own rules
 * (e.g. "the stage before the decision sets the pre-decision status") with
 * `extraValidators`.
 */
import type { ProcessDefinition } from './types.js';

export type DefinitionValidator = (def: ProcessDefinition) => string[];

export function validateDefinition(def: ProcessDefinition, extraValidators: DefinitionValidator[] = []): string[] {
  const out: string[] = [];
  if (!def.name?.trim()) out.push('Enter a name for the workflow.');
  if (!def.stages?.length) {
    out.push('Add at least one stage.');
    return out;
  }
  const stageKeys = new Set<string>();
  const last = def.stages[def.stages.length - 1];
  def.stages.forEach((s, si) => {
    const sn = `Stage ${si + 1}${s.name ? ` (${s.name})` : ''}`;
    if (!s.key?.trim()) out.push(`${sn}: a key is required.`);
    else if (stageKeys.has(s.key)) out.push(`${sn}: the key "${s.key}" is used twice.`);
    stageKeys.add(s.key);
    if (!s.name?.trim()) out.push(`${sn}: enter a name.`);
    if (!s.tasks?.length) out.push(`${sn}: add at least one task.`);
    const taskKeys = new Set<string>();
    (s.tasks ?? []).forEach((t, ti) => {
      const tn = `${sn}, task ${ti + 1}${t.name ? ` (${t.name})` : ''}`;
      if (!t.key?.trim()) out.push(`${tn}: a key is required.`);
      else if (taskKeys.has(t.key)) out.push(`${tn}: the key "${t.key}" is used twice in the stage.`);
      taskKeys.add(t.key);
      if (!t.name?.trim()) out.push(`${tn}: enter a name.`);
      if (t.role === undefined || t.role === null || t.role === '') out.push(`${tn}: select the role that performs the task.`);
      if (!t.form?.trim()) out.push(`${tn}: select a form.`);
      if (!t.actionLabel?.trim()) out.push(`${tn}: enter the dashboard action label.`);
      if (s !== last && t.decision) out.push(`${tn}: a decision can only be taken in the last stage.`);
    });
    if (s !== last && s.tasks?.length && s.tasks.every((t) => t.optional)) out.push(`${sn}: at least one task must be mandatory.`);
  });
  if (last.tasks?.length !== 1 || !last.tasks[0].decision) {
    out.push('The last stage must have exactly one task, which takes the decision.');
  } else {
    const outcomes = last.tasks[0].decision.outcomes ?? [];
    if (!outcomes.some((o) => o.terminal)) out.push('The decision needs at least one outcome that completes the workflow.');
    const seen = new Set<string>();
    for (const o of outcomes) {
      if (seen.has(o.key)) out.push(`The outcome "${o.key}" is defined twice.`);
      seen.add(o.key);
      if (!o.terminal) {
        const target = def.stages.find((s) => s.key === o.activatesStage);
        if (!target || target === last) out.push(`The "${o.key}" outcome needs the stage it activates.`);
        else if (!target.tasks.every((t) => t.onDemand)) {
          out.push(`The tasks of stage "${target.name}" must be "only when ordered" to be used by the "${o.key}" outcome.`);
        }
      }
    }
  }
  for (const v of extraValidators) out.push(...v(def));
  return out;
}
