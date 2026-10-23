import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicWrite, bounded, now, safePath, sanitize } from './safety.mjs';

export async function capture(store, command, { timeout = 30000, maxBytes = 2000000 } = {}) {
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== 'string' || value.includes('\0'))) throw Error('Comando inválido');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw Error('Timeout inválido');
  if (!Number.isInteger(maxBytes) || maxBytes < 1000 || maxBytes > 16000000) throw Error('Limite de captura inválido');
  const started = Date.now(), captureId = crypto.randomUUID();
  const result = await new Promise((resolve, reject) => {
    // Sem shell implícito. Permissões e eventuais descendentes pertencem ao cliente chamador.
    const child = spawn(command[0], command.slice(1), { cwd: store.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, timedOut = false, exceeded = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes <= maxBytes) chunks.push(chunk);
      else { exceeded = true; child.kill(); }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString('utf8'), code, signal, timedOut, exceeded, bytes }); });
  });
  // Saneamento antes de persistir; padrões heurísticos não autorizam imprimir segredos.
  const clean = sanitize(result.body);
  const relative = `.contexto/captures/${captureId}.log`;
  const file = safePath(store.root, relative, { existing: false });
  atomicWrite(file, clean);
  const lines = clean.split(/\r?\n/);
  const important = lines.filter(line => /error|fail|exception|fatal|warning|passed|tests?:|erro|falh|sucesso/i.test(line)).slice(0, 20);
  const summary = bounded([...important, ...lines.slice(-8)].filter((line, number, all) => all.indexOf(line) === number).join('\n'), 4000);
  const record = { id: captureId, executable: path.basename(command[0]), at: now(), duration_ms: Date.now() - started, exit_code: result.code, signal: result.signal, timed_out: result.timedOut, limit_exceeded: result.exceeded, available_bytes: result.bytes, stored_bytes: Buffer.byteLength(clean), source: relative, summary, success: result.code === 0 && !result.timedOut && !result.exceeded };
  store.db.prepare('INSERT INTO captures VALUES(?,?)').run(captureId, JSON.stringify(record));
  store.metric('capture', result.bytes, Buffer.byteLength(JSON.stringify(record)), { complete: !result.timedOut && !result.exceeded, success: record.success, baseline: 'observed_process_output' });
  return record;
}
export function readCapture(store, captureId, maxBytes = 12000) {
  if (!/^[a-f0-9-]{36}$/.test(captureId)) throw Error('ID de captura inválido');
  const record = store.db.prepare('SELECT body FROM captures WHERE id=?').get(captureId);
  if (!record) throw Error('Captura não encontrada');
  const data = JSON.parse(record.body);
  const body = fs.readFileSync(safePath(store.root, data.source), 'utf8');
  const excerpt = bounded(sanitize(body), maxBytes);
  return { ...data, body: excerpt, truncated: excerpt !== body };
}
