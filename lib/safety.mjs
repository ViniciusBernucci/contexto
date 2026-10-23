import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const normalized = value => value.split(path.sep).join('/');
export const now = () => new Date().toISOString();
export const id = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/.test(value)) throw Error('Identificador inválido');
  return value;
};
export function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export function safePath(root, relative, { existing = true } = {}) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\\')) throw Error('Use caminho relativo POSIX');
  if (relative.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Segmentos relativos/ambíguos proibidos');
  const target = path.resolve(root, relative);
  if (!inside(root, target)) throw Error('Caminho fora do projeto');
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error('Link pendente no caminho recusado'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) throw Error(`Arquivo ausente: ${relative}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw Error('Ancestral inválido');
    cursor = parent;
  }
  if (!inside(fs.realpathSync(root), fs.realpathSync(cursor))) throw Error('Link aponta para fora do projeto');
  let checked = path.resolve(root);
  for (const part of path.relative(root, cursor).split(path.sep).filter(Boolean)) {
    checked = path.join(checked, part);
    if (fs.lstatSync(checked).isSymbolicLink()) throw Error('Links em caminhos de dados/fontes não são permitidos');
  }
  return target;
}
export function secretPath(relative) {
  return relative.split('/').some(part => /^\.env(?:\.|$)/i.test(part) || /^(credentials?|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(part)) || /\.(pem|p12|pfx|key|sqlite|db)(?:-|$|\.)/i.test(relative);
}
export function sanitize(text) {
  return String(text)
    .replace(/(\b(?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\s\r\n"'`,;}\]]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[PRIVATE_KEY_REMOVED]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[TOKEN_REMOVED]')
    .replace(/(\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|connectionstring)\b["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';}]+)/gi, (_match, prefix, value) => prefix + (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
export function sanitizeValues(value) {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(sanitizeValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValues(item)]));
  return value;
}
export function bounded(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
export function jsonFile(file) {
  if (fs.statSync(file).size > 2_000_000) throw Error('JSON excede 2 MB');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function atomicWrite(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, body, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
