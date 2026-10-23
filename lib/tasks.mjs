import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, id, now, safePath, sanitize, sanitizeValues, secretPath, sha256 } from './safety.mjs';

const critical = new Set(['auth', 'authorization', 'data', 'migration', 'secrets', 'cross-layer-contract', 'concurrency', 'shared-infra']);
const standard = new Set(['business', 'api', 'dependency', 'functional']);
const profiles = ['simples', 'padrao', 'critico'];
const gateNames = ['implementation', 'review', 'audit', 'qa', 'integration', 'cleanup'];
function strings(values, field, { empty = false } = {}) {
  if (!Array.isArray(values) || (!empty && !values.length) || values.length > 100 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) throw Error(`Campo inválido: ${field}`);
  return [...new Set(values)];
}
export function getTask(store, task) {
  const row = store.db.prepare('SELECT body FROM tasks WHERE id=?').get(id(task));
  if (!row) throw Error('Tarefa não encontrada');
  return JSON.parse(row.body);
}
export function putTask(store, input) {
  id(input.id);
  if (!profiles.includes(input.profile)) throw Error('Perfil inválido');
  if (store.db.prepare('SELECT id FROM tasks WHERE id=?').get(input.id)) throw Error('Tarefa já existe; use eventos para atualização');
  const factors = strings(input.risk_factors || [], 'risk_factors', { empty: true });
  if (factors.some(factor => !critical.has(factor) && !standard.has(factor))) throw Error('Fator de risco desconhecido');
  const minimum = factors.some(factor => critical.has(factor)) ? 2 : factors.some(factor => standard.has(factor)) ? 1 : 0;
  if (profiles.indexOf(input.profile) < minimum) throw Error(`Risco exige perfil ${profiles[minimum]}`);
  if (typeof input.rationale !== 'string' || input.rationale.trim().length < 10 || input.rationale.length > 4000) throw Error('Justificativa de risco obrigatória (10 a 4000 caracteres)');
  const sources = strings(input.sources, 'sources');
  for (const relative of sources) { if (secretPath(relative)) throw Error('Fonte sensível proibida'); safePath(store.root, relative); }
  const dependencies = strings(input.dependencies || [], 'dependencies', { empty: true });
  for (const dependency of dependencies) { id(dependency); if (dependency === input.id) throw Error('Dependência cíclica'); getTask(store, dependency); }
  const task = { id: input.id, revision: 0, profile: input.profile, rationale: sanitize(input.rationale), risk_factors: factors, criteria: strings(input.criteria, 'criteria').map(sanitize), sources, dependencies, gates: {}, technical_rounds: 0, qa_rounds: 0, isolated: null, updated: now() };
  store.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, 0, JSON.stringify(task));
  return task;
}
export function snapshot(store, task) {
  const files = [];
  const taskDefinition = typeof task === 'string' ? getTask(store, task) : task;
  for (const relative of [...taskDefinition.sources].sort()) {
    if (secretPath(relative)) throw Error('Fonte sensível proibida');
    const file = safePath(store.root, relative);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > store.config.maxFileBytes) throw Error('Snapshot requer arquivos regulares dentro do limite');
    files.push([relative, sha256(fs.readFileSync(file))]);
  }
  return sha256(JSON.stringify(files));
}
function evidence(store, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw Error('Evidência local obrigatória');
  return values.map(item => {
    if (!item || typeof item.source !== 'string' || typeof item.detail !== 'string' || !item.detail.trim()) throw Error('Evidência requer source e detail');
    if (secretPath(item.source)) throw Error('Evidência sensível proibida');
    const file = safePath(store.root, item.source);
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 2000000) throw Error('Arquivo de evidência inválido');
    return { source: item.source, detail: sanitize(item.detail).slice(0, 4000), hash: sha256(fs.readFileSync(file)) };
  });
}
function currentGate(task, name, current) { return task.gates[name]?.snapshot === current ? task.gates[name] : null; }
function completeCoverage(task, gate) { return Array.isArray(gate?.coverage) && task.criteria.every(criterion => gate.coverage.includes(criterion)); }
function consolidatedReview(task, review, audit) {
  if (!review || !completeCoverage(task, review) || !['PASS', 'FAIL'].includes(review.status)) return false;
  if (review.status === 'PASS' && review.findings === 0) return true;
  return review.findings > 0 && audit?.status === 'PASS' && Array.isArray(review.finding_ids) && review.finding_ids.length === review.findings && Array.isArray(audit.decisions) && audit.decisions.length === review.findings && review.finding_ids.every(finding => audit.decisions.some(decision => decision.id === finding && (decision.decision !== 'APLICAR' || decision.verified === true)));
}
function evidenceValid(store, gate) {
  try { return gate.evidence.every(item => sha256(fs.readFileSync(safePath(store.root, item.source))) === item.hash); }
  catch { return false; }
}
export function readiness(store, task) {
  const current = snapshot(store, task);
  const missing = [];
  const gates = Object.fromEntries(gateNames.map(name => {
    const gate = currentGate(task, name, current);
    return [name, gate && evidenceValid(store, gate) ? gate : null];
  }));
  if (gates.implementation?.status !== 'PASS') missing.push('implementation');
  if (!consolidatedReview(task, gates.review, gates.audit)) missing.push('review');
  const noFindings = gates.review?.status === 'PASS' && gates.review.findings === 0;
  if (task.profile === 'critico' || !noFindings) {
    if (gates.audit?.status !== 'PASS') missing.push('audit');
  } else if (!['PASS', 'NA_SEM_ACHADOS'].includes(gates.audit?.status)) missing.push('audit');
  if (gates.qa?.status !== 'PASS' && !(task.profile === 'simples' && gates.qa?.status === 'COBERTO_NO_REVIEW')) missing.push('qa');
  for (const dependency of task.dependencies) if (!readiness(store, getTask(store, dependency)).ready) missing.push(`dependency:${dependency}`);
  return { id: task.id, revision: task.revision, profile: task.profile, snapshot: current, ready: !task.isolated && missing.length === 0, missing, isolated: task.isolated, gates: Object.fromEntries(gateNames.map(name => [name, gates[name]?.status || (task.gates[name] ? 'STALE' : 'PENDING')])) };
}
export function event(store, input) {
  if (!input || typeof input !== 'object') throw Error('Evento inválido');
  id(input.id); id(input.task); id(input.session);
  const clean = sanitizeValues(input);
  return store.transaction(() => {
    const previous = store.db.prepare('SELECT body FROM events WHERE id=?').get(clean.id);
    if (previous) {
      if (previous.body !== JSON.stringify(clean)) throw Error('ID idempotente reutilizado com conteúdo diferente');
      return { duplicate: true, task: getTask(store, clean.task) };
    }
    const task = getTask(store, clean.task);
    if (clean.expected_revision !== task.revision) throw Error(`Conflito de revisão: atual ${task.revision}`);
    if (clean.type === 'isolate') {
      if (typeof clean.reason !== 'string' || !clean.reason.trim()) throw Error('Motivo obrigatório');
      task.isolated = clean.reason.slice(0, 4000);
    } else if (clean.type === 'round') {
      if (!['technical', 'qa'].includes(clean.kind)) throw Error('Tipo de rodada inválido');
      const key = `${clean.kind}_rounds`;
      if (task[key] >= 3) throw Error('Limite de três rodadas; isole a tarefa');
      task[key]++;
    } else if (clean.type === 'elevate') {
      if (!profiles.includes(clean.profile) || profiles.indexOf(clean.profile) <= profiles.indexOf(task.profile)) throw Error('Somente elevação de perfil permitida');
      task.profile = clean.profile;
      task.gates = {};
    } else if (clean.type === 'gate') {
      if (!gateNames.includes(clean.gate)) throw Error('Gate inválido');
      const current = snapshot(store, task);
      if (clean.snapshot !== current) throw Error('Snapshot obsoleto');
      if (!['PASS', 'FAIL', 'BLOCKED', 'NA_SEM_ACHADOS', 'COBERTO_NO_REVIEW'].includes(clean.status)) throw Error('Status inválido');
      const implementation = currentGate(task, 'implementation', current);
      const review = currentGate(task, 'review', current);
      const audit = currentGate(task, 'audit', current);
      if (clean.gate !== 'implementation' && (!implementation || implementation.status !== 'PASS' || !evidenceValid(store, implementation))) throw Error('Implementação atual válida ausente');
      if (['review', 'audit', 'qa'].includes(clean.gate) && clean.session === implementation?.session) throw Error('Gate requer executor independente da implementação');
      if (clean.gate === 'audit' && clean.session === review?.session && clean.status !== 'NA_SEM_ACHADOS') throw Error('Auditor deve ser independente do revisor');
      if (clean.gate === 'audit' && !review) throw Error('Review atual ausente');
      if (clean.gate === 'qa' && clean.status !== 'COBERTO_NO_REVIEW' && (clean.session === review?.session || (audit?.status !== 'NA_SEM_ACHADOS' && clean.session === audit?.session))) throw Error('QA separado requer sessão independente do review e auditoria');
      if (clean.status === 'NA_SEM_ACHADOS' && (clean.gate !== 'audit' || task.profile === 'critico' || review?.status !== 'PASS' || review.findings !== 0)) throw Error('Auditoria não pode ser dispensada');
      if (clean.status === 'COBERTO_NO_REVIEW' && (clean.gate !== 'qa' || task.profile !== 'simples' || review?.status !== 'PASS' || clean.session !== review.session)) throw Error('QA só pode ser coberto pelo review independente em simples');
      if (clean.gate === 'review') {
        if (!Number.isInteger(clean.findings) || clean.findings < 0 || clean.findings > 1000) throw Error('Review requer número de achados');
        if (clean.findings > 0 && (!Array.isArray(clean.finding_ids) || clean.finding_ids.length !== clean.findings || new Set(clean.finding_ids).size !== clean.findings || clean.finding_ids.some(finding => typeof finding !== 'string' || !finding.trim() || finding.length > 200))) throw Error('Review requer IDs únicos de todos os achados');
        if (clean.status === 'PASS' && !completeCoverage(task, clean)) throw Error('Review PASS requer cobertura de todos os critérios');
      }
      if (clean.gate === 'qa' && ['PASS', 'COBERTO_NO_REVIEW'].includes(clean.status) && !completeCoverage(task, clean)) throw Error('QA requer cobertura de todos os critérios');
      if (clean.gate === 'audit' && clean.status === 'PASS') {
        if (!['PASS', 'FAIL'].includes(review.status) || !completeCoverage(task, review) || !evidenceValid(store, review)) throw Error('Review com cobertura essencial incompleta ou obsoleta');
        if (review.status === 'FAIL' && review.findings === 0) throw Error('Review FAIL sem achados permanece bloqueado; auditoria não pode inventar liberação');
        if (!Array.isArray(clean.decisions) || clean.decisions.length !== review.findings || new Set(clean.decisions.map(decision => decision.id)).size !== review.findings || clean.decisions.some(decision => !review.finding_ids?.includes(decision.id) || !['APLICAR', 'ADIAR', 'REJEITAR'].includes(decision.decision) || (decision.decision === 'APLICAR' && decision.verified !== true))) throw Error('Auditoria requer decisão única por achado e correções verificadas');
      }
      if (clean.gate === 'qa' && ['PASS', 'COBERTO_NO_REVIEW'].includes(clean.status)) {
        const currentReview = review && evidenceValid(store, review) ? review : null;
        const currentAudit = audit && evidenceValid(store, audit) ? audit : null;
        if (!consolidatedReview(task, currentReview, currentAudit)) throw Error('Review/auditoria essenciais ainda não liberados');
        if ((task.profile === 'critico' || currentReview.findings > 0) && currentAudit?.status !== 'PASS') throw Error('Auditoria essencial pendente');
      }
      if (['integration', 'cleanup'].includes(clean.gate) && clean.status === 'PASS' && !readiness(store, task).ready) throw Error('Gates da tarefa/dependências pendentes');
      if (clean.gate === 'cleanup' && clean.status === 'PASS' && currentGate(task, 'integration', current)?.status !== 'PASS') throw Error('Integração pendente');
      const gate = { status: clean.status, session: clean.session, snapshot: current, evidence: evidence(store, clean.evidence), at: now() };
      for (const key of ['coverage', 'findings', 'finding_ids', 'decisions']) if (clean[key] !== undefined) gate[key] = clean[key];
      task.gates[clean.gate] = gate;
      // Alterar o parecer invalida decisões derivadas, mesmo sem alteração no código.
      if (clean.gate === 'implementation') for (const key of gateNames.slice(1)) delete task.gates[key];
      if (clean.gate === 'review') for (const key of ['audit', 'qa', 'integration', 'cleanup']) delete task.gates[key];
      if (clean.gate === 'audit') for (const key of ['qa', 'integration', 'cleanup']) delete task.gates[key];
      if (clean.gate === 'qa') for (const key of ['integration', 'cleanup']) delete task.gates[key];
    } else throw Error('Tipo de evento inválido');
    task.revision++; task.updated = now();
    store.db.prepare('UPDATE tasks SET revision=?,body=? WHERE id=?').run(task.revision, JSON.stringify(task), task.id);
    store.db.prepare('INSERT INTO events VALUES(?,?,?)').run(clean.id, task.id, JSON.stringify(clean));
    return { duplicate: false, task };
  });
}
export function status(store, task) {
  const tasks = task ? [getTask(store, task)] : store.db.prepare('SELECT body FROM tasks ORDER BY id').all().map(row => JSON.parse(row.body));
  return tasks.map(item => readiness(store, item));
}
export function render(store) {
  const states = status(store);
  const lines = ['# Estado local do fluxo', '', 'Projeção gerada; SQLite é a fonte operacional. READY significa pronta para integrar, não entrega final.', '', '| Tarefa | Perfil | Revisão | Pronta | Pendências |', '| --- | --- | --- | --- | --- |'];
  for (const item of states) lines.push(`| ${item.id} | ${item.profile} | ${item.revision} | ${item.ready ? 'sim' : 'não'} | ${item.missing.join(', ')} |`);
  const file = path.join(store.folder, 'generated', 'status.md');
  safePath(store.root, '.contexto/generated/status.md', { existing: false });
  atomicWrite(file, lines.join('\n') + '\n');
  return { output: '.contexto/generated/status.md', tasks: states.length };
}
