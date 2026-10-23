import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomicWrite, id, jsonFile, safePath } from './safety.mjs';
import { refreshReport } from './metrics.mjs';

export const VERSION = '0.2.0';
export function ignoreLocal(root) {
  const file = path.join(root, '.gitignore');
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!previous.split(/\r?\n/).some(line => line.trim() === '/.contexto/')) {
    atomicWrite(file, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}\n# Contexto: dados locais\n/.contexto/\n`);
  }
}
export function defaultConfig(name, preset = 'generic') {
  id(preset);
  return { schema: 1, id: id(name), include: ['docs', 'src', 'app', 'routes', 'tests', 'README.md', 'AGENTS.md', 'CLAUDE.md'], exclude: ['node_modules', 'vendor', '.git', '.contexto', '.claude', '.agents', 'storage', 'dist', 'build'], maxFileBytes: 512000, maxTotalBytes: 50000000, workflow: { schema: 1, preset, timezone: 'UTC', plansDir: 'docs/planejamento/ia', reportsDir: 'docs/historico/reviews', deliveryDir: 'docs/historico/entregas', reviewBranchPrefix: 'revisao/', defaultProfile: 'padrao', rules: ['AGENTS.md'], repositories: [{ name, root: '.', layer: 'app' }], worktreeDir: '.worktrees', publish: 'manual' } };
}
export function initialize(root, name = path.basename(root).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9_.-]+/g, '-'), preset = 'generic', options = {}) {
  root = fs.realpathSync.native(root);
  id(preset);
  const folder = path.join(root, '.contexto');
  // Não seguir uma junction pré-existente para gravar em outro projeto.
  safePath(root, '.contexto', { existing: false });
  fs.mkdirSync(folder, { recursive: true });
  const config = path.join(folder, 'project.json');
  if (fs.existsSync(config)) throw Error('Projeto já inicializado; configuração preservada');
  atomicWrite(config, JSON.stringify(options.config || defaultConfig(name, preset), null, 2) + '\n');
  atomicWrite(path.join(folder, '.gitignore'), '*\n');
  if (options.writeIgnore !== false) ignoreLocal(root);
  return { project: name, config: '.contexto/project.json' };
}
export class Store {
  constructor(root) {
    this.root = fs.realpathSync.native(root);
    this.folder = safePath(this.root, '.contexto');
    this.config = jsonFile(safePath(this.root, '.contexto/project.json'));
    if (this.config.worktree && path.resolve(this.config.worktree.root) !== this.root) throw Error('Configuração pertence a outra worktree; não copie estados/aprovações');
    if (this.config.schema !== 1) throw Error('Versão de configuração não suportada');
    id(this.config.id);
    for (const key of ['include', 'exclude']) if (!Array.isArray(this.config[key]) || this.config[key].some(value => typeof value !== 'string' || !value)) throw Error(`Configuração inválida: ${key}`);
    for (const key of ['maxFileBytes', 'maxTotalBytes']) if (!Number.isSafeInteger(this.config[key]) || this.config[key] < 1 || this.config[key] > 1000000000) throw Error(`Limite inválido: ${key}`);
    safePath(this.root, '.contexto/context.sqlite', { existing: false });
    this.db = new DatabaseSync(path.join(this.folder, 'context.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, hash TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(path UNINDEXED,ordinal UNINDEXED,start_line UNINDEXED,hash UNINDEXED,body,tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,task TEXT NOT NULL,body TEXT NOT NULL,FOREIGN KEY(task) REFERENCES tasks(id));
      CREATE TABLE IF NOT EXISTS captures(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(kind TEXT NOT NULL,available INTEGER NOT NULL,returned INTEGER NOT NULL,at TEXT NOT NULL);`);
    this.transaction(() => {
      if (!this.db.prepare('PRAGMA table_info(metrics)').all().some(column => column.name === 'details')) this.db.exec("ALTER TABLE metrics ADD COLUMN details TEXT NOT NULL DEFAULT '{\"complete\":false,\"legacy\":true}'");
      this.db.exec('CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,body TEXT NOT NULL,at TEXT NOT NULL)');
    });
    const schema = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (schema && schema.value !== '1') { this.db.close(); throw Error('Versão de banco não suportada'); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('schema','1')").run();
    const project = this.db.prepare("SELECT value FROM meta WHERE key='project'").get();
    if (project && project.value !== this.config.id) { this.db.close(); throw Error('Identidade do banco diverge da configuração'); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('project',?)").run(this.config.id);
  }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
  metric(kind, available, returned, details = {}) {
    if (!['pack', 'capture'].includes(kind) || [available, returned].some(value => !Number.isSafeInteger(value) || value < 0)) throw Error('Métrica inválida');
    this.db.prepare('INSERT INTO metrics(kind,available,returned,at,details) VALUES(?,?,?,?,?)').run(kind, available, returned, new Date().toISOString(), JSON.stringify(details));
    refreshReport(this);
  }
}
