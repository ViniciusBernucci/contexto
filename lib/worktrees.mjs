import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultConfig, initialize, Store } from './store.mjs';
import { index } from './context.mjs';
import { atomicWrite, jsonFile, normalized, safePath, sha256 } from './safety.mjs';

const cli = fileURLToPath(new URL('../contexto.mjs', import.meta.url));
const marker = '# contexto-managed-post-checkout-v1';
const slug = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 65) || 'project';
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const quote = value => `'${normalized(value).replaceAll("'", "'\\''")}'`;

export function bashPath() {
  if (process.env.CONTEXTO_BASH) return process.env.CONTEXTO_BASH;
  if (process.platform !== 'win32') return '/bin/bash';
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    for (const relative of ['Git/usr/bin/bash.exe', 'Git/bin/bash.exe']) {
      const candidate = path.join(root, relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw Error('Bash não encontrado; configure CONTEXTO_BASH com o executável real');
}
export function git(root, args, { allowMissing = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  const result = spawnSync(bashPath(), ['-c', 'git -C "$1" "${@:2}"', 'contexto-git', normalized(root), ...args], { encoding: 'utf8', env, windowsHide: true, timeout: 15000, maxBuffer: 2000000 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !(allowMissing && result.status === 1)) throw Error(`Git falhou: ${result.stderr.trim() || result.status}`);
  return result.stdout.trim();
}
export function discover(project) {
  const root = fs.realpathSync.native(path.resolve(project));
  if (/[\r\n\0]/.test(root)) throw Error('Raiz com caracteres não suportados');
  const parts = git(root, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']).split(/\r?\n/);
  if (parts.length !== 3) throw Error('Topologia Git inválida');
  const [top, common, directory] = parts.map(value => fs.realpathSync.native(value));
  if (!samePath(top, root)) throw Error('Selecione a raiz exata da worktree, não um subdiretório');
  const first = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0').find(value => value.startsWith('worktree '));
  if (!first) throw Error('Checkout principal não identificado');
  const primary = fs.realpathSync.native(first.slice('worktree '.length));
  return { root, common, directory, primary, linked: !samePath(common, directory), branch: git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowMissing: true }) || null };
}
function locked(root, relative, operation) {
  const file = safePath(root, relative, { existing: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID(); let descriptor;
  const deadline = Date.now() + 15000;
  while (descriptor === undefined) {
    try { descriptor = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw Error(`Preparação ocupada: ${file}; não remova lock sem conferir o proprietário`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })); fs.closeSync(descriptor);
  try { return operation(); }
  finally {
    if (jsonFile(file).token !== token) throw Error('Ownership da preparação foi alterado');
    fs.unlinkSync(file);
  }
}
function ignoreRepository(info) {
  const file = safePath(info.common, 'info/exclude', { existing: false });
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!previous.split(/\r?\n/).some(line => line.trim() === '/.contexto/')) atomicWrite(file, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}\n# Contexto: estado isolado por worktree\n/.contexto/\n`);
}
function hook(info) {
  const custom = git(info.root, ['config', '--get-regexp', '^core\\.hooksPath$'], { allowMissing: true });
  if (custom) return { status: 'custom-hooks-path', automatic_hook: false, fallback: 'ensure obrigatório pelo criador/agente; hook customizado preservado' };
  const target = safePath(info.common, 'hooks/post-checkout', { existing: false });
  const stateFile = safePath(info.common, 'contexto/hook.json', { existing: false });
  const original = safePath(info.common, 'hooks/post-checkout.contexto-original', { existing: false });
  const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  let oldState = fs.existsSync(stateFile) ? jsonFile(stateFile) : null;
  if (oldState && (!previous || sha256(previous) !== oldState.hash || !previous.includes(marker))) throw Error('Hook gerenciado alterado externamente; conteúdo preservado');
  if (!oldState && previous?.includes(marker)) throw Error('Hook gerenciado sem recibo; recuperação explícita necessária');
  if (!oldState && fs.existsSync(original)) throw Error('Backup de hook já existe; conteúdo preservado');
  if (!oldState && previous !== null) {
    fs.copyFileSync(target, original, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(original, fs.statSync(target).mode);
  }
  const body = `#!/bin/sh\n${marker}\n# Executa primeiro o hook anterior e preserva seu exit code.\nif [ -x "$0.contexto-original" ]; then\n  "$0.contexto-original" "$@" || exit "$?"\nfi\n[ "$3" = "1" ] || exit 0\ncontexto_root=$(git rev-parse --show-toplevel) || exit "$?"\n${quote(process.execPath)} ${quote(cli)} ensure --project "$contexto_root" --from-hook >/dev/null\ncontexto_status=$?\nif [ "$contexto_status" -ne 0 ]; then\n  printf '%s\\n' 'Contexto: preparação automática falhou; o agente deve executar ensure antes de delegar.' >&2\nfi\nexit 0\n`;
  if (body !== previous) atomicWrite(target, body);
  fs.chmodSync(target, 0o755);
  atomicWrite(stateFile, JSON.stringify({ schema: 1, hash: sha256(body), original: fs.existsSync(original) ? 'hooks/post-checkout.contexto-original' : null }, null, 2) + '\n');
  return { status: 'installed', automatic_hook: true, previous_hook_preserved: fs.existsSync(original) };
}
function template(info, configFrom) {
  const sourceRoot = configFrom ? fs.realpathSync.native(path.resolve(configFrom)) : info.primary;
  const file = safePath(sourceRoot, '.contexto/project.json', { existing: false });
  const source = fs.existsSync(file) ? jsonFile(file) : defaultConfig(slug(path.basename(info.primary)));
  if (configFrom && !fs.existsSync(file)) throw Error('Configuração de origem ausente');
  const config = defaultConfig(slug(path.basename(info.primary)), source.workflow?.preset || 'generic');
  // Uma configuração do coordenador de múltiplos repositórios não vira allowlist da camada.
  if (samePath(sourceRoot, info.primary)) for (const key of ['include', 'exclude', 'maxFileBytes', 'maxTotalBytes']) if (source[key] !== undefined) config[key] = source[key];
  const selected = source.workflow?.repositories?.find(item => {
    try { return samePath(fs.realpathSync.native(path.resolve(sourceRoot, item.root)), info.primary); } catch { return false; }
  });
  config.workflow = { ...config.workflow, ...source.workflow, repositories: [{ name: selected?.name || config.id, root: '.', layer: selected?.layer || 'app' }] };
  return { config, sourceRoot };
}
export function setup(project, { configFrom } = {}) {
  const info = discover(project);
  return locked(info.common, 'contexto/setup.lock', () => {
    const file = safePath(info.common, 'contexto/defaults.json', { existing: false });
    let registration;
    if (fs.existsSync(file) && !configFrom) {
      registration = jsonFile(file);
      if (registration.schema !== 1 || !samePath(registration.common, info.common)) throw Error('Registro pertence a outro repositório');
    } else registration = { schema: 1, common: info.common, ...template(info, configFrom) };
    ignoreRepository(info);
    const installed = hook(info);
    registration.hook = installed;
    atomicWrite(file, JSON.stringify(registration, null, 2) + '\n');
    return { registered: true, root: info.root, common: info.common, hook: installed, tracked_files_changed: false };
  });
}
function worktreeConfig(registration, info) {
  const config = structuredClone(registration.config);
  config.id = `${slug(config.id)}-${sha256(info.root).slice(0, 12)}`;
  const workflow = config.workflow;
  for (const key of ['plansDir', 'reportsDir', 'deliveryDir', 'worktreeDir']) if (typeof workflow[key] === 'string') workflow[key] = normalized(path.relative(info.root, path.resolve(registration.sourceRoot, workflow[key]))) || '.';
  workflow.rules = [...new Set([...(workflow.rules || []).map(rule => normalized(path.relative(info.root, path.resolve(registration.sourceRoot, rule)))), ...['AGENTS.md', 'CLAUDE.md'].filter(rule => fs.existsSync(path.join(info.root, rule)))])];
  config.worktree = { schema: 1, root: info.root, common: info.common, directory: info.directory, inherited_from: registration.sourceRoot };
  return config;
}
export function ensure(project, { configFrom, fromHook = false, onlyRegistered = false } = {}) {
  const info = discover(project);
  if (fromHook && (!info.linked || ['main', 'master'].includes(info.branch))) return { skipped: true, reason: 'checkout principal ou branch protegida' };
  if (['main', 'master'].includes(info.branch)) throw Error('Preparação automática não escreve em main/master');
  if (git(info.root, ['ls-files', '--', ':(icase).contexto']).length) throw Error('.contexto contém arquivos versionados; preparação recusada sem alterar o checkout');
  const registrationFile = safePath(info.common, 'contexto/defaults.json', { existing: false });
  if (!fs.existsSync(registrationFile)) {
    if (onlyRegistered) throw Error('Repositório ainda não ativado; use setup uma vez');
    setup(project, { configFrom });
  } else if (configFrom) setup(project, { configFrom });
  const registration = jsonFile(registrationFile);
  if (registration.schema !== 1 || !samePath(registration.common, info.common)) throw Error('Registro de repositório inválido');
  return locked(info.root, '.contexto/prepare.lock', () => {
    const file = safePath(info.root, '.contexto/project.json', { existing: false });
    let created = false;
    if (!fs.existsSync(file)) { const config = worktreeConfig(registration, info); initialize(info.root, config.id, config.workflow.preset, { writeIgnore: false, config }); created = true; }
    const store = new Store(info.root);
    try {
      const binding = store.config.worktree;
      if (binding && (!samePath(binding.root, info.root) || !samePath(binding.common, info.common) || !samePath(binding.directory, info.directory))) throw Error('Estado copiado de outra worktree; aprovações não podem ser reutilizadas');
      if (!binding) {
        if (['tasks', 'events', 'captures'].some(table => store.db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total > 0)) throw Error('Estado legado sem identidade de worktree; preserve/exporte definições antes de migrar');
        store.config.worktree = { schema: 1, root: info.root, common: info.common, directory: info.directory, inherited_from: registration.sourceRoot };
        atomicWrite(file, JSON.stringify(store.config, null, 2) + '\n');
      }
      return { prepared: true, created, root: info.root, project: store.config.id, isolated_database: normalized(path.join(info.root, '.contexto/context.sqlite')), index: index(store), tracked_files_changed: false };
    } finally { store.close(); }
  });
}

export function archive(project) {
  const info = discover(project);
  if (!info.linked || ['main', 'master'].includes(info.branch)) throw Error('Arquivamento automático exige worktree de tarefa');
  return locked(info.root, '.contexto/prepare.lock', () => {
    const store = new Store(info.root);
    try {
      const binding = store.config.worktree;
      if (!binding || !samePath(binding.root, info.root) || !samePath(binding.common, info.common)) throw Error('Identidade da worktree não comprovada');
      const signature = () => JSON.stringify({ tasks: store.db.prepare('SELECT id,revision FROM tasks ORDER BY id').all(), events: store.db.prepare('SELECT COUNT(*) AS total FROM events').get().total, captures: store.db.prepare('SELECT COUNT(*) AS total FROM captures').get().total, metrics: store.db.prepare('SELECT COUNT(*) AS total FROM metrics').get().total, usage: store.db.prepare('SELECT COUNT(*) AS total FROM usage').get().total });
      const before = signature();
      const relative = `contexto/archives/${store.config.id}-${crypto.randomUUID()}`;
      const destination = safePath(info.common, relative, { existing: false });
      fs.mkdirSync(destination, { recursive: true });
      const database = safePath(info.common, `${relative}/context.sqlite`, { existing: false });
      store.db.prepare('VACUUM INTO ?').run(database);
      const files = [{ source: '.contexto/context.sqlite', archive: 'context.sqlite', sha256: sha256(fs.readFileSync(database)) }];
      atomicWrite(path.join(destination, 'project.json'), JSON.stringify(store.config, null, 2) + '\n');
      const known = new Set(['context.sqlite', 'context.sqlite-wal', 'context.sqlite-shm', 'project.json', '.gitignore', 'prepare.lock', 'generated/status.md', 'reports/efficiency.md', 'reports/efficiency.json']);
      for (const row of store.db.prepare('SELECT body FROM captures').all()) {
        const record = JSON.parse(row.body);
        if (!/^\.contexto\/captures\/[a-f0-9-]{36}\.log$/.test(record.source)) throw Error('Captura com origem inválida');
        const source = safePath(info.root, record.source);
        const targetName = record.source.slice('.contexto/'.length);
        const target = safePath(info.common, `${relative}/${targetName}`, { existing: false });
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        known.add(targetName); files.push({ source: record.source, archive: targetName, sha256: sha256(fs.readFileSync(target)) });
      }
      const unknown = [];
      function inventory(folder) {
        for (const name of fs.readdirSync(folder)) {
          const file = path.join(folder, name), key = normalized(path.relative(store.folder, file)), stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) unknown.push(key);
          else if (stat.isDirectory()) inventory(file);
          else if (!known.has(key)) unknown.push(key);
        }
      }
      inventory(store.folder);
      if (signature() !== before) throw Error('Estado mudou durante arquivamento; preserve worktree e repita sem executores ativos');
      atomicWrite(path.join(destination, 'manifest.json'), JSON.stringify({ schema: 1, historical_only: true, worktree: info.root, project: store.config.id, state_signature: before, files, unknown_entries: unknown }, null, 2) + '\n');
      return { archived: true, historical_only: true, output: destination, cleanup_safe: unknown.length === 0, unknown_entries: unknown, note: 'Não remove a worktree; ownership, Git e ausência de executores ainda precisam ser comprovados' };
    } finally { store.close(); }
  });
}
