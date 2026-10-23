import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialize, Store } from '../lib/store.mjs';
import { summarize, usage, writeReport } from '../lib/metrics.mjs';
import { capture } from '../lib/capture.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-metrics-'));
  initialize(root, 'sample');
  const store = new Store(root);
  t.after(() => {
    store.close();
    const real = fs.realpathSync(root);
    if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith('contexto-metrics-')) throw Error('Limpeza fora da fixture');
    fs.rmSync(real, { recursive: true });
  });
  return store;
}
test('bytes e estimativas têm fórmula reproduzível e relatório automático', t => {
  const store = fixture(t);
  store.metric('pack', 10000, 2000, { complete: true });
  const report = summarize(store), row = report.operations[0];
  assert.equal(row.bytes_avoided, 8000); assert.equal(row.estimated_tokens_avoided, 2000); assert.equal(row.reduction_percent, 80);
  assert.match(fs.readFileSync(path.join(store.root, '.contexto/reports/efficiency.md'), 'utf8'), /8000/);
  assert.equal(report.daily[0].calls, 1); assert.ok(report.suggestions.length);
});
test('overhead negativo é exposto e capturas incompletas não inflam economia', t => {
  const store = fixture(t);
  store.metric('capture', 4, 404, { complete: true });
  store.metric('capture', 100000, 500, { complete: false });
  const report = summarize(store), row = report.operations[0];
  assert.equal(row.bytes_avoided, -400); assert.equal(row.reduction_percent, -10000);
  assert.equal(report.incomplete_calls_excluded_from_savings, 1);
  assert.equal(row.calls, 2); assert.equal(report.daily[0].calls, 1);
  assert.match(report.suggestions.join(' '), /mais que a referência/);
});
test('contadores importados comparam trabalho/modelo sem duplicar cache', t => {
  const store = fixture(t), other = fixture(t);
  const records = [
    { id: 'b1', workload: 'sample-task', model: 'sample-model', arm: 'baseline', input_tokens: 12000, output_tokens: 1000, cached_input_tokens: 6000, prompt: 'SYNTHETIC_PRIVATE' },
    { id: 'c1', workload: 'sample-task', model: 'sample-model', arm: 'current', input_tokens: 7000, output_tokens: 900, cached_input_tokens: 3000 }
  ];
  assert.equal(usage(store, { records }).inserted, 2);
  assert.equal(usage(store, { records }).duplicates, 2);
  const report = writeReport(store);
  assert.equal(report.comparisons[0].observed_token_difference, 5100);
  assert.equal(report.comparisons[0].reduction_percent, 39.23);
  assert.doesNotMatch(JSON.stringify(report) + JSON.stringify(store.db.prepare('SELECT * FROM usage').all()), /SYNTHETIC_PRIVATE/);
  assert.equal(summarize(other).client_measurements, 0);
  assert.throws(() => usage(store, { records: [{ ...records[0], id: 'new-id' }, { ...records[1], input_tokens: 8000 }] }), /reutilizado/);
  assert.equal(summarize(store).client_measurements, 2);
});
test('baseline ausente, modelo distinto e contadores inválidos não viram economia real', t => {
  const store = fixture(t);
  const item = { id: 'one', workload: 'sample-task', model: 'model-a', arm: 'current', input_tokens: 10, output_tokens: 4 };
  usage(store, item); usage(store, { ...item, id: 'two', model: 'model-b', arm: 'baseline' });
  assert.ok(summarize(store).comparisons.every(row => !row.comparable));
  assert.throws(() => usage(store, { ...item, cached_input_tokens: 11 }), /inválido/);
  assert.throws(() => usage(store, { ...item, output_tokens: -1 }), /inválida/);
});
test('captura real gera métricas e exclui timeout automaticamente', async t => {
  const store = fixture(t);
  await capture(store, [process.execPath, '-e', "console.log('x'.repeat(10000))"]);
  await capture(store, [process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeout: 50 });
  const report = summarize(store);
  assert.equal(report.operations[0].calls, 2); assert.equal(report.operations[0].incomplete_calls, 1);
  assert.ok(report.operations[0].bytes_avoided > 0);
});
test('migração preserva métricas antigas mas as exclui sem prova de completude', t => {
  const store = fixture(t), database = path.join(store.root, '.contexto/context.sqlite');
  const second = new DatabaseSync(database);
  second.exec("ALTER TABLE metrics DROP COLUMN details; INSERT INTO metrics VALUES('capture',10000,500,'2026-01-01T00:00:00Z')"); second.close();
  const upgraded = new Store(store.root);
  try { assert.equal(summarize(upgraded).incomplete_calls_excluded_from_savings, 1); assert.equal(summarize(upgraded).operations[0].bytes_avoided, 0); }
  finally { upgraded.close(); }
});

test('relatório indisponível preserva recibo e código do comando já executado', t => {
  const store = fixture(t);
  fs.writeFileSync(path.join(store.root, '.contexto/reports'), 'arquivo do usuário');
  const cli = fileURLToPath(new URL('../contexto.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'capture', '--project', store.root, '--', process.execPath, '-e', 'process.exitCode=7'], { encoding: 'utf8' });
  assert.equal(result.status, 7); assert.equal(JSON.parse(result.stdout).exit_code, 7);
  assert.match(result.stderr, /warning/); assert.equal(summarize(store).operations[0].calls, 1);
  assert.equal(fs.readFileSync(path.join(store.root, '.contexto/reports'), 'utf8'), 'arquivo do usuário');
  assert.throws(() => writeReport(store));
  const input = path.join(store.root, 'usage.json');
  fs.writeFileSync(input, JSON.stringify({ id: 'one', workload: 'sample-task', model: 'sample-model', arm: 'current', input_tokens: 10, output_tokens: 1 }));
  const imported = spawnSync(process.execPath, [cli, 'usage', '--project', store.root, '--file', input], { encoding: 'utf8' });
  assert.equal(imported.status, 0); assert.equal(JSON.parse(imported.stdout).inserted, 1); assert.match(imported.stderr, /warning/);
});
