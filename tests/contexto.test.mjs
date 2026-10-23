import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, initialize } from '../lib/store.mjs';
import { index, search, read, pack } from '../lib/context.mjs';
import { capture } from '../lib/capture.mjs';
import { event, getTask, putTask, readiness, snapshot } from '../lib/tasks.mjs';
import { exportProject, importProject } from '../lib/transfer.mjs';
import { handle } from '../lib/mcp.mjs';
import { bounded, sanitize } from '../lib/safety.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-test-'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'api.md'), '# Upload\nContrato batch de fotos.\n');
  fs.writeFileSync(path.join(root, 'proof.txt'), 'Critério demonstrado pelo executor independente.');
  initialize(root, 'fixture');
  const store = new Store(root);
  t.after(() => {
    store.close();
    const real = fs.realpathSync(root), temporary = fs.realpathSync(os.tmpdir());
    if (path.dirname(real) !== temporary || !path.basename(real).startsWith('contexto-test-')) throw Error('Limpeza fora da fixture recusada');
    fs.rmSync(real, { recursive: true });
  });
  return store;
}
function task(store, profile = 'simples', extra = {}) {
  return putTask(store, { id: 'T1', profile, rationale: 'Mudança localizada sem alteração de contrato.', criteria: ['C1'], sources: ['docs/api.md'], dependencies: [], risk_factors: [], ...extra });
}
function gate(store, name, session, extra = {}) {
  const current = getTask(store, 'T1');
  return event(store, { id: `${name}-${current.revision}`, task: 'T1', session, expected_revision: current.revision, type: 'gate', gate: name, status: 'PASS', snapshot: snapshot(store, current), evidence: [{ source: 'proof.txt', detail: 'Evidência observada' }], ...extra });
}
function simpleReady(store) {
  task(store); gate(store, 'implementation', 'implementer');
  gate(store, 'review', 'reviewer', { findings: 0, coverage: ['C1'] });
  gate(store, 'audit', 'coordinator', { status: 'NA_SEM_ACHADOS' });
  gate(store, 'qa', 'reviewer', { status: 'COBERTO_NO_REVIEW', coverage: ['C1'] });
}

test('indexação incremental, busca com acentos e remoção de fonte', t => {
  const store = fixture(t);
  fs.writeFileSync(path.join(store.root, 'docs', 'permissao.md'), 'Autorização por empreendimento');
  assert.equal(index(store).updated, 2);
  assert.equal(index(store).updated, 0);
  assert.equal(search(store, 'autorizacao').hits.length, 1);
  fs.unlinkSync(path.join(store.root, 'docs', 'permissao.md'));
  assert.equal(index(store).removed, 1);
});
test('fonte alterada não volta como memória válida antes de reindexar', t => {
  const store = fixture(t); index(store);
  fs.writeFileSync(path.join(store.root, 'docs', 'api.md'), 'Outro contrato');
  const result = search(store, 'batch');
  assert.equal(result.hits.length, 0); assert.deepEqual(result.stale, ['docs/api.md']);
});
test('segredos e fontes fora da allowlist são recusados', t => {
  const store = fixture(t);
  fs.writeFileSync(path.join(store.root, 'docs', '.env'), 'password=segredo');
  index(store);
  assert.throws(() => read(store, 'docs/.env'), /excluída/);
  assert.throws(() => read(store, '../outside'));
  assert.throws(() => read(store, 'proof.txt'), /include/);
  assert.doesNotMatch(sanitize('password=abc123\nAuthorization: BearerABC'), /abc123|BearerABC/);
});
test('pacote respeita bytes UTF-8 e preserva critérios obrigatórios', t => {
  const store = fixture(t); task(store); index(store);
  const result = pack(store, { task: 'T1', role: 'reviewer', maxBytes: 1000 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1000);
  assert.deepEqual(result.task.criteria, ['C1']);
  assert.equal(bounded('ação🎯', 5), 'açã');
});
test('risco não pode ser reduzido e dependência ausente é recusada', t => {
  const store = fixture(t);
  assert.throws(() => task(store, 'simples', { risk_factors: ['authorization'] }), /critico/);
  assert.throws(() => task(store, 'padrao', { dependencies: ['ausente'] }), /encontrada/);
});
test('autorreview não satisfaz gate', t => {
  const store = fixture(t); task(store); gate(store, 'implementation', 'same-session');
  assert.throws(() => gate(store, 'review', 'same-session', { findings: 0, coverage: ['C1'] }), /independente/);
});
test('simples só dispensa QA separado com cobertura independente completa', t => {
  const store = fixture(t); simpleReady(store);
  assert.equal(readiness(store, getTask(store, 'T1')).ready, true);
});
test('perfil padrão exige QA separado da implementação', t => {
  const store = fixture(t); task(store, 'padrao'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { findings: 0, coverage: ['C1'] });
  gate(store, 'audit', 'coord', { status: 'NA_SEM_ACHADOS' });
  assert.throws(() => gate(store, 'qa', 'review', { status: 'COBERTO_NO_REVIEW', coverage: ['C1'] }), /simples/);
  gate(store, 'qa', 'qa', { coverage: ['C1'] });
  assert.equal(readiness(store, getTask(store, 'T1')).ready, true);
});
test('crítico exige auditor independente mesmo sem achados', t => {
  const store = fixture(t); task(store, 'critico'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { findings: 0, coverage: ['C1'] });
  assert.throws(() => gate(store, 'audit', 'coord', { status: 'NA_SEM_ACHADOS' }), /dispensada/);
  assert.throws(() => gate(store, 'audit', 'review', { decisions: [] }), /Auditor/);
  gate(store, 'audit', 'auditor', { decisions: [] });
  gate(store, 'qa', 'qa', { coverage: ['C1'] });
  assert.equal(readiness(store, getTask(store, 'T1')).ready, true);
});
test('evento idempotente e revisão esperada impedem aplicação dupla', t => {
  const store = fixture(t); task(store);
  const input = { id: 'round-1', task: 'T1', session: 'coord', expected_revision: 0, type: 'round', kind: 'technical' };
  event(store, input);
  assert.equal(event(store, input).duplicate, true);
  assert.equal(getTask(store, 'T1').technical_rounds, 1);
  assert.throws(() => event(store, { ...input, id: 'other' }), /revisão/);
  assert.throws(() => event(store, { ...input, kind: 'qa' }), /conteúdo diferente/);
});
test('alterar código ou evidência invalida prontidão', t => {
  const store = fixture(t); simpleReady(store);
  fs.writeFileSync(path.join(store.root, 'proof.txt'), 'Prova substituída');
  assert.equal(readiness(store, getTask(store, 'T1')).ready, false);
  fs.writeFileSync(path.join(store.root, 'docs', 'api.md'), 'Mudança de código');
  assert.equal(readiness(store, getTask(store, 'T1')).gates.review, 'STALE');
});
test('rodadas têm limite transacional de três', t => {
  const store = fixture(t); task(store);
  for (let number = 0; number < 3; number++) event(store, { id: `r${number}`, task: 'T1', session: 'coord', expected_revision: number, type: 'round', kind: 'technical' });
  assert.throws(() => event(store, { id: 'r3', task: 'T1', session: 'coord', expected_revision: 3, type: 'round', kind: 'technical' }), /três/);
  assert.equal(getTask(store, 'T1').revision, 3);
});
test('captura preserva exit code e saneia antes de persistir', async t => {
  const store = fixture(t);
  const result = await capture(store, [process.execPath, '-e', "console.log('password=abc123');console.error('FAIL C1');process.exitCode=7"]);
  assert.equal(result.exit_code, 7); assert.equal(result.success, false);
  assert.doesNotMatch(fs.readFileSync(path.join(store.root, result.source), 'utf8'), /abc123/);
  assert.match(result.summary, /FAIL C1/);
});
test('captura sinaliza timeout e limite; não declara sucesso', async t => {
  const store = fixture(t);
  const timed = await capture(store, [process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeout: 50 });
  assert.equal(timed.timed_out, true); assert.equal(timed.success, false);
  const large = await capture(store, [process.execPath, '-e', "console.log('a'.repeat(100000))"], { maxBytes: 1000 });
  assert.equal(large.limit_exceeded, true); assert.equal(large.success, false);
});
test('exportação/importação não transporta aprovações', t => {
  const store = fixture(t); simpleReady(store);
  const file = path.join(store.root, 'transfer.json'); exportProject(store, file);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(payload.tasks[0].gates, undefined);
  const destination = fixture(t); importProject(destination, file);
  assert.equal(readiness(destination, getTask(destination, 'T1')).ready, false);
  assert.throws(() => importProject(destination, file), /já existe/);
});
test('MCP oferece consultas, não execução ou alteração de gates', t => {
  const store = fixture(t); index(store);
  const list = handle(store, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(list.result.tools.length, 4);
  const response = handle(store, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'context_search', arguments: { query: 'upload' } } });
  assert.equal(JSON.parse(response.result.content[0].text).hits.length, 1);
  assert.ok(handle(store, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'capture' } }).error);
});
test('CLI funciona em caminho com espaços e propaga falha capturada', t => {
  const store = fixture(t);
  const cli = fileURLToPath(new URL('../contexto.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'capture', '--project', store.root, '--', process.execPath, '-e', 'process.exitCode=4'], { encoding: 'utf8' });
  assert.equal(result.status, 4); assert.equal(JSON.parse(result.stdout).exit_code, 4);
});

test('REVIEW-001: Bearer e Basic são removidos antes de log e diagnóstico', async t => {
  const store = fixture(t);
  const result = await capture(store, [process.execPath, '-e', "console.log('Authorization: Bearer SYNTHETIC_CREDENTIAL');console.log('Proxy-Authorization: Basic SYNTHETIC_BASIC')"]);
  const log = fs.readFileSync(path.join(store.root, result.source), 'utf8');
  assert.doesNotMatch(log + result.summary, /SYNTHETIC_CREDENTIAL|SYNTHETIC_BASIC/);
});
test('REVIEW-002: dot segments não contornam allowlist via CLI/MCP', t => {
  const store = fixture(t);
  fs.writeFileSync(path.join(store.root, 'private-note.txt'), 'SYNTHETIC_PRIVATE');
  assert.throws(() => read(store, 'docs/../private-note.txt'));
  const response = handle(store, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_read', arguments: { source: 'docs/../private-note.txt' } } });
  assert.equal(response.result.isError, true);
  assert.doesNotMatch(JSON.stringify(response), /SYNTHETIC_PRIVATE/);
});
test('REVIEW-003: decisões duplicadas ou IDs estranhos não liberam achados', t => {
  const store = fixture(t); task(store); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { findings: 2, finding_ids: ['R1', 'R2'], coverage: ['C1'] });
  assert.throws(() => gate(store, 'audit', 'audit', { decisions: [{ id: 'R1', decision: 'REJEITAR' }, { id: 'R1', decision: 'REJEITAR' }] }), /única/);
  assert.throws(() => gate(store, 'audit', 'audit', { decisions: [{ id: 'R1', decision: 'REJEITAR' }, { id: 'R3', decision: 'REJEITAR' }] }), /única/);
  assert.equal(readiness(store, getTask(store, 'T1')).ready, false);
});
test('REVIEW-004: auditoria resolve falso positivo preservando parecer FAIL', t => {
  const store = fixture(t); task(store, 'padrao'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { status: 'FAIL', findings: 1, finding_ids: ['R1'], coverage: ['C1'] });
  gate(store, 'audit', 'audit', { decisions: [{ id: 'R1', decision: 'REJEITAR' }] });
  gate(store, 'qa', 'qa', { coverage: ['C1'] });
  assert.equal(readiness(store, getTask(store, 'T1')).ready, true);
  assert.equal(getTask(store, 'T1').gates.review.status, 'FAIL');
});
test('REVIEW-004: auditoria não libera lacuna essencial de cobertura', t => {
  const store = fixture(t); task(store); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { status: 'FAIL', findings: 1, finding_ids: ['R1'], coverage: [] });
  assert.throws(() => gate(store, 'audit', 'audit', { decisions: [{ id: 'R1', decision: 'REJEITAR' }] }), /cobertura essencial/);
});
test('REVIEW-005: QA separado não reutiliza sessão de review', t => {
  const store = fixture(t); task(store, 'padrao'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { findings: 0, coverage: ['C1'] });
  gate(store, 'audit', 'coord', { status: 'NA_SEM_ACHADOS' });
  assert.throws(() => gate(store, 'qa', 'review', { coverage: ['C1'] }), /independente/);
});
test('QA prematuro não aprova antes dos gates técnicos', t => {
  const store = fixture(t); task(store, 'critico'); gate(store, 'implementation', 'impl');
  assert.throws(() => gate(store, 'qa', 'qa', { coverage: ['C1'] }), /liberados/);
});
test('FAIL sem achados não pode ser liberado por auditoria vazia', t => {
  const store = fixture(t); task(store, 'padrao'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { status: 'FAIL', findings: 0, finding_ids: [], coverage: ['C1'] });
  assert.throws(() => gate(store, 'audit', 'audit', { decisions: [] }), /permanece bloqueado/);
  assert.equal(readiness(store, getTask(store, 'T1')).ready, false);
});
test('NA de auditoria não cria um auditor fictício para independência do QA', t => {
  const store = fixture(t); task(store, 'padrao'); gate(store, 'implementation', 'impl');
  gate(store, 'review', 'review', { findings: 0, coverage: ['C1'] });
  gate(store, 'audit', 'coordenador', { status: 'NA_SEM_ACHADOS' });
  gate(store, 'qa', 'coordenador', { coverage: ['C1'] });
  assert.equal(readiness(store, getTask(store, 'T1')).ready, true);
});
test('redação de credenciais preserva campos vizinhos e estrutura JSON', () => {
  const result = sanitize('{"log":"Authorization: Bearer SYNTHETIC_CREDENTIAL","next":"preserve","password":"abc123"}');
  const parsed = JSON.parse(result);
  assert.equal(parsed.next, 'preserve');
  assert.doesNotMatch(result, /SYNTHETIC_CREDENTIAL|abc123/);
});
