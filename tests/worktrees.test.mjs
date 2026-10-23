import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archive, discover, ensure, git, setup } from '../lib/worktrees.mjs';
import { Store, initialize } from '../lib/store.mjs';
import { putTask } from '../lib/tasks.mjs';
const cli = fileURLToPath(new URL('../contexto.mjs', import.meta.url));

function fixture(t, { previousHook = false, customHook = false } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'contexto-worktrees-'));
  t.after(() => {
    const real = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
    if (path.dirname(real) !== parent || !path.basename(real).startsWith('contexto-worktrees-')) throw Error('Limpeza fora da fixture recusada');
    fs.rmSync(real, { recursive: true });
  });
  const root = path.join(temporary, 'repo with spaces'); fs.mkdirSync(root);
  git(root, ['init', '-b', 'fixture-base']);
  fs.mkdirSync(path.join(root, 'docs')); fs.writeFileSync(path.join(root, 'docs', 'rules.md'), 'Regra comum de aprovação.');
  fs.writeFileSync(path.join(root, '.gitignore'), '# regra de usuário\n');
  git(root, ['add', '--', 'docs/rules.md', '.gitignore']);
  git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'test: fixture isolada']);
  const info = discover(root);
  if (previousHook) { fs.writeFileSync(path.join(info.common, 'hooks/post-checkout'), '#!/bin/sh\nprintf original > "$PWD/original-hook.txt"\n'); fs.chmodSync(path.join(info.common, 'hooks/post-checkout'), 0o755); }
  if (customHook) { fs.mkdirSync(path.join(root, 'custom-hooks')); git(root, ['config', 'core.hooksPath', 'custom-hooks']); }
  return { root, temporary, info, leaf: name => path.join(temporary, `worktree ${name}`) };
}
function add(root, target, name) { git(root, ['worktree', 'add', '-b', name, target]); }

test('hook prepara worktree nova sem init nem alteração do gitignore rastreado', t => {
  const f = fixture(t); const result = setup(f.root);
  assert.equal(result.hook.automatic_hook, true);
  const target = f.leaf('one'); add(f.root, target, 'fixture-one');
  const config = JSON.parse(fs.readFileSync(path.join(target, '.contexto/project.json'), 'utf8'));
  assert.equal(config.workflow.preset, 'generic'); assert.equal(config.worktree.root, fs.realpathSync.native(target));
  assert.equal(git(target, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(target, '.gitignore'), 'utf8').replaceAll('\r\n', '\n'), '# regra de usuário\n');
  const store = new Store(target); try { assert.equal(store.db.prepare('SELECT COUNT(*) AS total FROM sources').get().total, 1); } finally { store.close(); }
});
test('preparação é idempotente e bancos/tarefas são isolados', t => {
  const f = fixture(t); setup(f.root); const first = f.leaf('first'), second = f.leaf('second');
  add(f.root, first, 'fixture-first'); add(f.root, second, 'fixture-second');
  const a = new Store(first), b = new Store(second);
  try {
    putTask(a, { id: 'T1', profile: 'simples', rationale: 'Mudança de texto localizada.', risk_factors: [], criteria: ['C1'], sources: ['docs/rules.md'], dependencies: [] });
    assert.equal(b.db.prepare('SELECT COUNT(*) AS total FROM tasks').get().total, 0);
    assert.notEqual(a.config.id, b.config.id);
  } finally { a.close(); b.close(); }
  assert.equal(ensure(first).created, false);
  const a2 = new Store(first); try { assert.equal(a2.db.prepare('SELECT COUNT(*) AS total FROM tasks').get().total, 1); } finally { a2.close(); }
});
test('CLI inicializa primeiro uso mesmo quando worktree add não disparou hook', t => {
  const f = fixture(t); setup(f.root); const target = f.leaf('no checkout');
  git(f.root, ['-c', 'core.hooksPath=', 'worktree', 'add', '-b', 'fixture-cli', target]);
  assert.equal(fs.existsSync(path.join(target, '.contexto/project.json')), false);
  const result = spawnSync(process.execPath, [cli, 'search', '--project', target, '--query', 'aprovação'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).hits.length, 1);
});
test('setup preserva hook anterior e não o duplica em retomada', t => {
  const f = fixture(t, { previousHook: true }); setup(f.root); setup(f.root);
  const target = f.leaf('hook'); add(f.root, target, 'fixture-hook');
  assert.equal(fs.readFileSync(path.join(target, 'original-hook.txt'), 'utf8'), 'original');
  assert.ok(fs.existsSync(path.join(target, '.contexto/project.json')));
});
test('hooksPath customizado é preservado e ensure continua automático pelo agente', t => {
  const f = fixture(t, { customHook: true }); const result = setup(f.root);
  assert.equal(result.hook.automatic_hook, false); assert.equal(git(f.root, ['config', '--get', 'core.hooksPath']), 'custom-hooks');
  const target = f.leaf('custom'); add(f.root, target, 'fixture-custom');
  assert.equal(ensure(target).created, true); assert.equal(git(target, ['status', '--porcelain']), '');
});

test('hooksPath vazio não anuncia hook automático e o agente prepara a worktree', t => {
  const f = fixture(t); git(f.root, ['config', 'core.hooksPath', '']);
  assert.equal(setup(f.root).hook.automatic_hook, false);
  const target = f.leaf('disabled'); add(f.root, target, 'fixture-disabled');
  assert.equal(fs.existsSync(path.join(target, '.contexto/project.json')), false);
  assert.equal(ensure(target).prepared, true);
});

test('estado versionado com caixa diferente é recusado sem alterar arquivos', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.CONTEXTO'));
  fs.writeFileSync(path.join(f.root, '.CONTEXTO/project.json'), '{}');
  git(f.root, ['add', '--', '.CONTEXTO/project.json']);
  git(f.root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'test: estado rastreado']);
  assert.throws(() => ensure(f.root), /versionados/);
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  assert.equal(fs.readFileSync(path.join(f.root, '.CONTEXTO/project.json'), 'utf8'), '{}');
});
test('configuração herdada é rebased por raiz sem importar dados de outro projeto', t => {
  const f = fixture(t); initialize(f.root, 'configured');
  const file = path.join(f.root, '.contexto/project.json'), config = JSON.parse(fs.readFileSync(file));
  config.include = ['docs']; config.workflow.timezone = 'America/Sao_Paulo'; config.workflow.plansDir = 'planning';
  fs.writeFileSync(file, JSON.stringify(config)); setup(f.root, { configFrom: f.root });
  const target = f.leaf('inherit'); add(f.root, target, 'fixture-inherit');
  const inherited = JSON.parse(fs.readFileSync(path.join(target, '.contexto/project.json')));
  assert.deepEqual(inherited.include, ['docs']); assert.equal(inherited.workflow.timezone, config.workflow.timezone);
  assert.equal(path.resolve(target, inherited.workflow.plansDir), path.join(f.root, 'planning'));
});
test('preparação concorrente da mesma worktree não recria configuração nem perde tarefas', async t => {
  const f = fixture(t); setup(f.root); const target = f.leaf('parallel');
  git(f.root, ['-c', 'core.hooksPath=', 'worktree', 'add', '-b', 'fixture-parallel', target]);
  const run = () => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, 'ensure', '--project', target]); let output = '', error = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => error += chunk);
    child.on('close', code => resolve({ code, output, error }));
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(results.every(item => item.code === 0), JSON.stringify(results));
  assert.equal(results.filter(item => JSON.parse(item.output).created).length, 1);
});
test('cópia de estado entre worktrees é recusada e hook ignora checkout principal', t => {
  const f = fixture(t); setup(f.root); const first = f.leaf('a'), second = f.leaf('b');
  add(f.root, first, 'fixture-a'); add(f.root, second, 'fixture-b');
  fs.copyFileSync(path.join(first, '.contexto/project.json'), path.join(second, '.contexto/project.json'));
  assert.throws(() => ensure(second), /outra worktree/);
  assert.equal(ensure(f.root, { fromHook: true }).skipped, true);
  assert.equal(fs.existsSync(path.join(f.root, '.contexto')), false);
});
test('arquivamento preserva SQLite e bloqueia limpeza com arquivos desconhecidos', t => {
  const f = fixture(t); setup(f.root); const target = f.leaf('archive'); add(f.root, target, 'fixture-archive');
  const result = archive(target); assert.equal(result.cleanup_safe, true); assert.ok(fs.existsSync(path.join(result.output, 'context.sqlite')));
  fs.writeFileSync(path.join(target, '.contexto', 'manual-note.txt'), 'Não descartar');
  const blocked = archive(target); assert.equal(blocked.cleanup_safe, false); assert.deepEqual(blocked.unknown_entries, ['manual-note.txt']);
  assert.ok(fs.existsSync(target));
});
