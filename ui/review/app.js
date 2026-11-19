const app = document.querySelector('#app');
let session;
let selectedGroup;
let profile;
let preview;
let pending;
let reviewed;
let busy = false;
let statusElement;
const invalidSteps = new Map();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function append(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}
function heading(text, level = 2) { return element('h' + level, '', text); }
function paragraph(text, className = '') { return element('p', className, text); }
function code(text) { return element('code', '', text ?? '—'); }
function field(label, control) {
  const wrapper = element('label', 'field');
  append(wrapper, element('span', 'field-label', label), control);
  return wrapper;
}
function button(label, onClick, className = '', disabled = false) {
  const control = element('button', className, label);
  control.type = 'button';
  control.disabled = disabled || busy;
  control.addEventListener('click', onClick);
  return control;
}
function list(items, empty = 'None recorded') {
  if (!items?.length) return paragraph(empty, 'muted');
  const ul = element('ul');
  for (const item of items) append(ul, element('li', '', item));
  return ul;
}
function labeledValue(label, value) {
  const item = element('div', 'fact');
  append(item, element('dt', '', label), element('dd', '', value ?? '—'));
  return item;
}
function showStatus(message, error = false) {
  if (!statusElement) return;
  statusElement.className = error ? 'status error' : 'status';
  statusElement.textContent = message;
}
async function request(action, payload) {
  if (busy) return;
  busy = true;
  const enabled = [...app.querySelectorAll('button:enabled, input:enabled, textarea:enabled')];
  for (const control of enabled) control.disabled = true;
  showStatus('Working…');
  try {
    const response = await fetch('/api/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Operation failed.');
    return result;
  } catch (error) {
    showStatus(error.message, true);
    return null;
  } finally {
    busy = false;
    for (const control of enabled) control.disabled = false;
  }
}
function changed() {
  preview = undefined;
  pending = undefined;
  reviewed = undefined;
  const section = document.querySelector('#result');
  if (section) section.replaceChildren(paragraph('Changes are not previewed. Save a draft or preview again.', 'muted'));
}
function textarea(value, rows = 3) {
  const control = element('textarea');
  control.value = value || '';
  control.rows = rows;
  control.addEventListener('input', changed);
  return control;
}
function textInput(value) {
  const control = element('input');
  control.type = 'text';
  control.value = value || '';
  control.addEventListener('input', changed);
  return control;
}
function stringsField(label, rule, key) {
  const input = textarea(rule[key].join('\n'), Math.max(2, Math.min(5, rule[key].length + 1)));
  input.addEventListener('input', () => { rule[key] = input.value.split('\n').map(value => value.trim()).filter(Boolean); });
  const wrapper = field(label, input);
  append(wrapper, paragraph('One item per line.', 'hint'));
  return wrapper;
}
function renderList() {
  const aside = element('aside', 'sidebar');
  append(aside, heading('Observed groups'), paragraph(`${session.groups.length} groups · ${session.candidates.length} selected candidates`, 'muted'));
  const navigation = element('nav');
  navigation.setAttribute('aria-label', 'Observed error groups');
  const selected = new Set(session.candidates.map(item => item.groupId));
  for (const group of session.groups) {
    const control = button(group.message || group.id, () => { selectedGroup = group.id; render(); }, 'group-button');
    control.setAttribute('aria-current', selectedGroup === group.id ? 'true' : 'false');
    append(control, element('small', '', `${group.id} · ${selected.has(group.id) ? 'Selected' : 'Outside selection'}`));
    navigation.append(control);
  }
  if (!session.groups.length) append(navigation, paragraph('No groups in this analysis.'));
  return append(aside, navigation);
}
function renderEvidence(group) {
  const section = element('section', 'card');
  append(section, heading('Observation'), paragraph(group.message, 'lead'));
  const facts = element('dl', 'facts');
  append(facts, labeledValue('Group ID', group.id), labeledValue('Project', group.project), labeledValue('Environment', group.environment),
    labeledValue('Release', group.release), labeledValue('Type', group.type), labeledValue('Page', group.pagePath),
    labeledValue('Captured records', group.count), labeledValue('Observed views', group.viewCount));
  section.append(facts);
  const evidence = group.evidence?.[0];
  if (evidence) {
    append(section, heading('Representative record', 3), paragraph(evidence.id, 'mono muted'));
    if (evidence.stack) append(section, element('pre', 'code-block', evidence.stack));
    if (evidence.reproduction?.length) append(section, heading('Reported reproduction', 4), list(evidence.reproduction));
    if (evidence.preconditions?.length) append(section, heading('Reported preconditions', 4), list(evidence.preconditions));
  }
  if (group.context?.conflicts?.length) append(section, heading('Source conflicts', 3), list(group.context.conflicts));
  if (group.context?.questions?.length) append(section, heading('Source questions', 3), list(group.context.questions));
  return section;
}
function renderCandidates(group) {
  const section = element('section', 'card');
  const candidates = session.candidates.filter(item => item.groupId === group.id);
  append(section, heading(`Candidates · ${candidates.length}`));
  if (!candidates.length) {
    append(section, paragraph('This group is outside the saved candidate selection. Rerun analyze to change the selection.', 'muted'));
    return section;
  }
  for (const candidate of candidates) {
    const article = element('article', 'candidate');
    append(article, heading(candidate.title, 3), paragraph(`${candidate.id} · ${candidate.state} · rule ${candidate.ruleId || 'none'}`, 'mono muted'),
      heading('Observed facts', 4), list(candidate.facts), heading('Expected result', 4), paragraph(candidate.expected?.text || 'Not confirmed'),
      heading('Expected result source', 4), paragraph(candidate.expected?.source || 'Not supplied'),
      heading('Reproduction', 4), list(candidate.reproduction), heading('Preconditions', 4), list(candidate.preconditions),
      heading('Saved steps', 4), element('pre', 'code-block', JSON.stringify(candidate.steps, null, 2)),
      heading('Questions and blockers', 4), list(candidate.questions, 'No recorded candidate questions.'));
    section.append(article);
  }
  return section;
}
function editRule(rule) {
  const panel = element('section', 'card editor');
  append(panel, heading('Review answers'), paragraph(`Rule ${rule.id}`, 'mono muted'));
  const matched = session.rules.find(item => item.id === rule.id)?.groupIds ?? [];
  append(panel, paragraph(`Applies to ${matched.length} observed group${matched.length === 1 ? '' : 's'}.`, 'muted'), list(matched, 'No observed group matches this rule.'));
  const match = element('details');
  append(match, element('summary', '', 'Rule scope'), element('pre', 'code-block', JSON.stringify(rule.match, null, 2)));
  panel.append(match);
  for (const [label, key] of [['Title', 'title'], ['Requirement', 'requirement'], ['Expected result source', 'expectedSource']]) {
    const input = key === 'requirement' ? textarea(rule[key]) : textInput(rule[key]);
    input.addEventListener('input', () => { rule[key] = input.value; });
    panel.append(field(label, input));
  }
  panel.append(stringsField('Preconditions', rule, 'preconditions'));
  const checkLabel = element('label', 'check-field');
  const check = element('input'); check.type = 'checkbox'; check.checked = rule.setupConfirmed;
  check.addEventListener('change', () => { rule.setupConfirmed = check.checked; changed(); });
  append(checkLabel, check, element('span', '', 'Setup and required preconditions confirmed'));
  panel.append(checkLabel);
  panel.append(stringsField('Remaining questions', rule, 'questions'));
  append(panel, paragraph('Resolve a question only after recording the verified answer in a field above.', 'hint'));
  const steps = textarea(invalidSteps.get(rule.id) ?? JSON.stringify(rule.steps, null, 2), 9);
  if (invalidSteps.has(rule.id)) steps.setAttribute('aria-invalid', 'true');
  steps.spellcheck = false;
  steps.addEventListener('input', () => {
    try {
      const parsed = JSON.parse(steps.value);
      if (!Array.isArray(parsed)) throw new Error('Expected an array.');
      rule.steps = parsed;
      invalidSteps.delete(rule.id);
      steps.removeAttribute('aria-invalid');
    } catch {
      invalidSteps.set(rule.id, steps.value);
      steps.setAttribute('aria-invalid', 'true');
    }
  });
  append(panel, field('Test steps · JSON array', steps), paragraph('Use open only for observed paths. Add confirmed actions and assertions yourself. Invalid JSON blocks preview.', 'hint'));
  return panel;
}
function renderEditor(group) {
  const candidateRules = new Set(session.candidates.filter(item => item.groupId === group.id).map(item => item.ruleId).filter(Boolean));
  const section = element('div', 'editor-stack');
  if (!profile || session.editBlocker) return append(section, paragraph(session.editBlocker || 'No editable profile.', 'notice'));
  if (!session.candidates.some(candidate => candidate.groupId === group.id)) return append(section, paragraph('Outside the selected candidates. Select another group to edit its rules.', 'notice'));
  const rules = profile.scenarios.filter(rule => candidateRules.has(rule.id) || session.rules.some(entry => entry.id === rule.id && entry.groupIds.includes(group.id)));
  if (!rules.length) return append(section, paragraph('No rule applies to this group. Choose a selected group.', 'notice'));
  for (const rule of rules) section.append(editRule(rule));
  return section;
}
function renderWorkflow() {
  const section = element('section', 'card workflow');
  append(section, heading('Save and verify'), paragraph('Answers are saved only when you select an action. The source bundle stays untouched.', 'muted'));
  const controls = element('div', 'button-row');
  append(controls,
    button('Save draft', async () => {
      if (invalidSteps.size) return showStatus('Fix the step JSON for ' + [...invalidSteps.keys()].join(', ') + ' before saving.', true);
      const value = await request('draft', { profile });
      if (value) showStatus(`Draft saved in the review output as ${value.file}. Reopen with --draft to continue.`);
    }, '', !!session.editBlocker),
    button('Preview changes', async () => {
      if (invalidSteps.size) return showStatus('Fix the step JSON for ' + [...invalidSteps.keys()].join(', ') + ' before preview.', true);
      const value = await request('preview', { profile });
      if (!value) return;
      preview = value;
      pending = undefined; reviewed = undefined;
      showPreview();
      showStatus('Preview is ready. Review every affected candidate before generating.');
    }, 'primary', !!session.editBlocker));
  append(section, controls);
  const result = element('div'); result.id = 'result';
  append(result, paragraph('Choose a group and edit its answers, then preview the changes.', 'muted'));
  append(section, result);
  return section;
}
function showPreview() {
  const result = document.querySelector('#result');
  result.replaceChildren();
  const section = element('section', 'result-panel');
  append(section, heading('Change preview', 3), paragraph(`Profile SHA-256 ${preview.profileHash}`, 'mono muted'),
    paragraph(`Changed rules ${preview.changes.length ? preview.changes.join(', ') : 'none'}`),
    paragraph(`${preview.candidates.length} regenerated candidates`));
  for (const candidate of preview.candidates) {
    const detail = element('details');
    append(detail, element('summary', '', `${candidate.id} · ${candidate.state} · ${candidate.title}`),
      paragraph(`Group ${candidate.groupId} · Rule ${candidate.ruleId || 'none'}`, 'mono muted'),
      heading('Remaining questions', 4), list(candidate.questions));
    section.append(detail);
  }
  append(section, button('Create profile and pending bundle', async () => {
    const value = await request('generate', { profile, profileHash: preview.profileHash });
    if (!value) return;
    pending = value; preview = undefined; showGenerated();
    showStatus(`New profile and pending bundle saved in review output. Bundle ${value.folder}.`);
  }, 'primary'));
  result.append(section);
}
function renderReadiness(summary) {
  const section = element('div', 'readiness');
  append(section, paragraph(`Readiness ${summary.status} · ${summary.counts.ready} ready · ${summary.counts.blocked} blocked`, 'strong'));
  if (summary.cases?.length) for (const item of summary.cases) {
    if (item.blockers.length) append(section, paragraph(`${item.caseId} · ${item.blockers.join(' · ')}`, 'muted'));
  }
  return section;
}
function showGenerated() {
  const result = document.querySelector('#result'); result.replaceChildren();
  const section = element('section', 'result-panel');
  append(section, heading('Generated bundle', 3), paragraph(`Profile ${pending.file} · Bundle ${pending.folder}`, 'mono'),
    renderReadiness(pending.readiness), paragraph(pending.sourceChecked ? 'Original input bytes checked.' : 'Original input bytes not independently checked.', 'muted'));
  const report = element('details');
  append(report, element('summary', '', 'Review generated report'), element('pre', 'code-block', pending.report));
  section.append(report);
  const suite = element('details');
  append(suite, element('summary', '', 'Review generated case suite'), element('pre', 'code-block', JSON.stringify(pending.suite ?? 'No suite generated', null, 2)));
  section.append(suite);
  const confirmation = element('label', 'check-field');
  const check = element('input'); check.type = 'checkbox';
  append(confirmation, check, element('span', '', 'I reviewed the generated report and case suite.'));
  const acknowledge = button('Confirm review', async () => {
    if (!check.checked) return;
    const value = await request('acknowledge', { folder: pending.folder, confirmed: true });
    if (!value) return;
    reviewed = value; pending = undefined; showReviewed();
    showStatus(`Reviewed bundle saved as ${value.folder}.`);
  }, 'primary', true);
  check.addEventListener('change', () => { acknowledge.disabled = !check.checked; });
  append(section, confirmation, acknowledge);
  result.append(section);
}
function showReviewed() {
  const result = document.querySelector('#result'); result.replaceChildren();
  const section = element('section', 'result-panel');
  append(section, heading('Review confirmed', 3), paragraph(`Reviewed bundle ${reviewed.folder}`, 'mono'), renderReadiness(reviewed.readiness),
    paragraph(reviewed.sourceChecked ? 'Original input bytes checked.' : 'Original input bytes not independently checked.', 'muted'));
  if (reviewed.readiness.status === 'ready') append(section, button('Prepare Flow QA workspace', async () => {
    const value = await request('prepare', { folder: reviewed.folder });
    if (!value) return;
    append(section, paragraph(`Workspace ${value.folder} created. Configure a target before running the suite.`, 'success'));
    showStatus(`Flow QA workspace saved as ${value.folder}.`);
  }, 'primary'));
  else append(section, paragraph('Resolve remaining blockers in the original source or profile, then generate another bundle.', 'notice'));
  result.append(section);
}
function render() {
  app.replaceChildren();
  const top = element('section', 'intro');
  append(top, element('p', 'eyebrow', 'VERIFIED ANALYSIS / LOCAL REVIEW'), heading('Review error evidence'),
    paragraph('Inspect the captured error, answer its test questions, and create a new reviewed bundle.'));
  const details = element('dl', 'summary');
  append(details, labeledValue('Input SHA-256', session.readiness.inputSha256), labeledValue('Analysis SHA-256', session.readiness.analysisSha256),
    labeledValue('Suite SHA-256', session.readiness.suiteSha256 || 'No suite'),
    labeledValue('Original input', session.sourceChecked ? 'Byte verified' : 'Not supplied for independent check'),
    labeledValue('Saved review', session.readiness.reviewed ? 'Acknowledged' : 'Pending'));
  top.append(details);
  statusElement = element('p', 'status'); statusElement.setAttribute('role', 'status');
  top.append(statusElement);
  app.append(top);
  const layout = element('div', 'layout');
  const group = session.groups.find(item => item.id === selectedGroup);
  const center = element('div', 'main-column');
  if (group) append(center, renderEvidence(group), renderCandidates(group), renderEditor(group));
  else append(center, paragraph('Select an observed group.'));
  append(layout, renderList(), center);
  app.append(layout, renderWorkflow());
  if (pending) showGenerated();
  else if (reviewed) showReviewed();
  else if (preview) showPreview();
}
async function start() {
  try {
    const response = await fetch('/api/session');
    if (!response.ok) throw new Error('Could not open the verified analysis.');
    session = await response.json();
    profile = session.profile;
    selectedGroup = session.candidates[0]?.groupId || session.groups[0]?.id;
    render();
  } catch (error) {
    app.replaceChildren(paragraph(error.message, 'error'));
  }
}
start();
