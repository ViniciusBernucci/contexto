import fs from 'node:fs';
import { atomicWrite, sanitize } from './safety.mjs';
import { putTask } from './tasks.mjs';
import { index } from './context.mjs';

export function exportProject(store, file) {
  const tasks = store.db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(row => {
    const { id, profile, rationale, risk_factors, criteria, sources, dependencies } = JSON.parse(row.body);
    return { id, profile, rationale, risk_factors, criteria, sources, dependencies };
  });
  const payload = { schema: 1, project: store.config.id, tasks, note: 'Somente definições. Código/documentos via seus próprios meios. Índice reconstruído no destino; aprovações, eventos, logs e credenciais não são transferidos.' };
  atomicWrite(file, JSON.stringify(payload, null, 2) + '\n');
  return { output: file, tasks: tasks.length, approvals_exported: false };
}
export function importProject(store, file) {
  if (fs.statSync(file).size > 2000000) throw Error('Importação excede 2 MB');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (payload.schema !== 1 || !Array.isArray(payload.tasks) || payload.tasks.length > 1000) throw Error('Formato de exportação inválido');
  // putTask rejeita colisões e referências ausentes; transação evita importação parcial.
  const count = store.transaction(() => {
    for (const task of payload.tasks) putTask(store, task);
    return payload.tasks.length;
  });
  return { imported: count, project: store.config.id, reindex_required: true, approvals_imported: false };
}
