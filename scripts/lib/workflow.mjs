/**
 * Helpers shared by the API smoke journey (scripts/smoke-journey.mjs) and the
 * browser suite (e2e/smoke.mjs): valid data for any department form, and
 * "every officer submits his task" through the real API.
 */
import { CHALLAN_VERIFIED, challanVerificationRequired, initialTaskFormData, visibleQuestions } from '@srisaa/noc-domain';

/** Valid, complete data for a department form (every question answered "OK"). */
export function validFormData(form, app, officerName, task) {
  const d = initialTaskFormData(form, app, officerName, app.applied_date || '01-Jan-2026');
  const yes = (o) => {
    for (const k of Object.keys(o)) if (/_ok$|^agree$|^conditions_complied$|^recommendation$|^pnoc_complied$/.test(k) && o[k] === '') o[k] = 'Y';
  };
  yes(d);
  if (Array.isArray(d.blocks)) d.blocks.forEach(yes);
  if ('remark' in d || form.kind === 'questionnaire') d.remark = d.remark || `${form.name}: in order.`;
  if ('submitted_by' in d && !d.submitted_by) d.submitted_by = officerName;
  if ('inspection_date' in d && !d.inspection_date) d.inspection_date = '05-Jan-2026';
  if (form.kind === 'questionnaire') {
    for (let pass = 0; pass < 3; pass++) {
      for (const q of visibleQuestions(form, d)) {
        if (!d[q.key]) d[q.key] = q.options?.length ? (q.options.find((o) => o.value === 'Y' || o.value === '1')?.value ?? q.options[0].value) : 'Satisfactory.';
      }
    }
  }
  if (task && app.workflow && challanVerificationRequired(app, app.workflow, task)) d[CHALLAN_VERIFIED] = 'Y';
  return d;
}

/**
 * Every open task before the final decision is submitted by its officer
 * (tasks that must wait for another are retried) until only the decision is
 * left. `call(method, path, token, body)` → `{ status, json }`; `login(username)` → token.
 * Returns the application as the last officer left it and who acted.
 */
export async function advanceToDecision({ call, login, id, app, skip = [] }) {
  const tokens = {};
  const as = async (username) => (tokens[username] ??= await login(username));
  const forms = (await call('GET', '/config/forms', await as('monitor.hq'))).json;
  const finalStage = () => app.workflow.stages.at(-1).key;
  const officers = [];
  for (let round = 0; round < 40; round++) {
    const notes = app.workflow.tasks.filter((t) => t.state === 'active' && t.stage_key !== finalStage() && !skip.includes(t.task_key));
    if (!notes.length) break;
    let progressed = false;
    for (const t of notes) {
      const form = forms.find((f) => f.id === t.form);
      const r = await call('POST', `/dept/applications/${id}/tasks/${t.task_id}/submit`, await as(t.assignee), { data: validFormData(form, app, t.assignee_name || t.assignee, t) });
      if (r.status === 200) {
        app = r.json.application;
        officers.push(t.assignee);
        progressed = true;
        break;
      }
    }
    if (!progressed) return { app, officers, stuck: notes.map((t) => `${t.name} (${t.assignee})`) };
  }
  const decision = app.workflow.tasks.find((t) => t.state === 'active' && t.stage_key === finalStage()) ?? null;
  return { app, officers, decision, stuck: null };
}
