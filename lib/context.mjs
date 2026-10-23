import fs from 'node:fs';
import path from 'node:path';
import { bounded, inside, normalized, safePath, sanitize, secretPath, sha256 } from './safety.mjs';

function allowed(store, relative) {
  const parts = relative.split('/');
  return !secretPath(relative) && !parts.some(part => store.config.exclude.includes(part));
}
export function source(store, relative) {
  const file = safePath(store.root, relative);
  if (!allowed(store, relative)) throw Error(`Fonte excluída: ${relative}`);
  if (!store.config.include.some(prefix => relative === prefix || relative.startsWith(prefix.replace(/\/$/, '') + '/'))) throw Error('Fonte não pertence à lista include');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > store.config.maxFileBytes) throw Error('Fonte não textual ou acima do limite');
  const buffer = fs.readFileSync(file);
  if (buffer.includes(0)) throw Error('Fonte binária excluída');
  return { path: relative, hash: sha256(buffer), body: sanitize(buffer.toString('utf8')), bytes: buffer.length };
}
export function index(store) {
  const found = new Map();
  let total = 0;
  function visit(file) {
    const relative = normalized(path.relative(store.root, file));
    if (!allowed(store, relative) || fs.lstatSync(file).isSymbolicLink()) return;
    if (!inside(store.root, fs.realpathSync(file))) return;
    const stat = fs.statSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name)); return; }
    if (!stat.isFile() || stat.size > store.config.maxFileBytes || found.has(relative)) return;
    total += stat.size;
    if (total > store.config.maxTotalBytes) throw Error('Indexação excede maxTotalBytes; reduza include');
    try { found.set(relative, source(store, relative)); }
    catch (error) { if (!/binária/.test(error.message)) throw error; }
  }
  for (const include of store.config.include) {
    const file = safePath(store.root, include, { existing: false });
    if (fs.existsSync(file)) visit(file);
  }
  return store.transaction(() => {
    let updated = 0, unchanged = 0, removed = 0;
    for (const item of found.values()) {
      const previous = store.db.prepare('SELECT hash FROM sources WHERE path=?').get(item.path);
      if (previous?.hash === item.hash) { unchanged++; continue; }
      store.db.prepare('DELETE FROM chunks WHERE path=?').run(item.path);
      store.db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?)').run(item.path, item.hash, item.bytes);
      const lines = item.body.split('\n');
      let ordinal = 0, start = 0, chunk = '';
      for (let number = 0; number < lines.length; number++) {
        if (chunk && (Buffer.byteLength(chunk) + Buffer.byteLength(lines[number]) > 6000 || number - start >= 60)) {
          store.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?)').run(item.path, ordinal++, start + 1, item.hash, chunk);
          start = number; chunk = '';
        }
        chunk += lines[number] + '\n';
      }
      if (chunk) store.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?)').run(item.path, ordinal, start + 1, item.hash, chunk);
      updated++;
    }
    for (const item of store.db.prepare('SELECT path FROM sources').all()) if (!found.has(item.path)) {
      store.db.prepare('DELETE FROM chunks WHERE path=?').run(item.path);
      store.db.prepare('DELETE FROM sources WHERE path=?').run(item.path); removed++;
    }
    return { updated, unchanged, removed, sources: found.size, bytes: total };
  });
}
export function search(store, query, limit = 5) {
  if (typeof query !== 'string' || query.length > 1000) throw Error('Consulta inválida');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('limit deve estar entre 1 e 20');
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) || [];
  if (!tokens.length) return { hits: [], stale: [], excluded: [] };
  const match = tokens.map(token => `"${token}"`).join(' OR ');
  const rows = store.db.prepare("SELECT path,ordinal,start_line,hash,body,bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?").all(match, Math.min(limit * 5, 100));
  const hashes = new Map(), hits = [], stale = new Set(), excluded = new Set();
  for (const row of rows) {
    if (!hashes.has(row.path)) {
      try { hashes.set(row.path, source(store, row.path).hash); }
      catch { hashes.set(row.path, null); excluded.add(row.path); }
    }
    if (hashes.get(row.path) !== row.hash) { stale.add(row.path); continue; }
    if (hits.length < limit) hits.push({ source: row.path, start_line: row.start_line, hash: row.hash, excerpt: bounded(row.body, 900) });
  }
  return { hits, stale: [...stale], excluded: [...excluded], truncated: rows.length >= Math.min(limit * 5, 100) };
}
export function read(store, relative, start = 1, lines = 60, maxBytes = 12000) {
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(lines) || lines < 1 || lines > 500) throw Error('Intervalo de linhas inválido');
  const item = source(store, relative);
  const all = item.body.split('\n');
  const selected = all.slice(start - 1, start - 1 + lines).join('\n');
  const body = bounded(selected, maxBytes);
  return { source: relative, hash: item.hash, start_line: start, total_lines: all.length, body, truncated: body !== selected || start - 1 + lines < all.length };
}
export function pack(store, { task, role = 'implementer', query = '', maxBytes = 10000 }) {
  if (!['implementer', 'reviewer', 'auditor', 'qa', 'coordinator'].includes(role)) throw Error('Papel inválido');
  if (!Number.isInteger(maxBytes) || maxBytes < 1000 || maxBytes > 64000) throw Error('maxBytes deve estar entre 1000 e 64000');
  const row = task ? store.db.prepare('SELECT body FROM tasks WHERE id=?').get(task) : null;
  if (task && !row) throw Error('Tarefa não encontrada');
  const definition = row ? JSON.parse(row.body) : null;
  const result = { project: store.config.id, role, historical_data: true, task: definition ? { id: definition.id, revision: definition.revision, profile: definition.profile, criteria: definition.criteria, sources: definition.sources, dependencies: definition.dependencies, gates: Object.fromEntries(Object.entries(definition.gates).map(([key, gate]) => [key, { status: gate.status, snapshot: gate.snapshot, session: gate.session, evidence: gate.evidence }])) } : null, hits: [], omitted: [], budget_bytes: maxBytes };
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw Error('Estado/critério obrigatório excede orçamento; aumente maxBytes ou reduza a tarefa');
  const retrieval = search(store, query || definition?.criteria.join(' ') || role, 10);
  result.stale = retrieval.stale;
  let available = 0;
  for (const hit of retrieval.hits) {
    available += Buffer.byteLength(JSON.stringify(hit));
    result.hits.push(hit);
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes - 500) { result.hits.pop(); result.omitted.push({ source: hit.source, start_line: hit.start_line }); }
  }
  // O inventário também consome orçamento: nunca retorne um JSON acima do limite.
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) { result.omitted_count = result.omitted.length; result.omitted = []; }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw Error('Metadados excedem orçamento; aumente maxBytes');
  store.metric('pack', available, Buffer.byteLength(JSON.stringify(result)), { complete: true, baseline: 'candidate_snippets' });
  return result;
}
