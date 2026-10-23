#!/usr/bin/env node
// Cópia deliberada do pacote, sem dados e sem edição de configurações globais.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from './lib/safety.mjs';
const source = path.dirname(fileURLToPath(import.meta.url));
const index = process.argv.indexOf('--dest');
if (index < 0 || !process.argv[index + 1]) { console.log('node install.mjs --dest PASTA_NOVA\nRequer Node >=22.13. Não copia dados, segredos ou configurações de cliente.'); process.exit(0); }
const destination = path.resolve(process.argv[index + 1]);
if (fs.existsSync(destination) || inside(source, destination) || inside(destination, source)) throw Error('Destino deve ser novo e fora da instalação original');
fs.mkdirSync(destination, { recursive: true });
for (const entry of ['contexto.mjs', 'package.json', 'install.mjs', '.gitignore', 'lib', 'tests', 'README.md', 'INSTALL.md']) {
  const from = path.join(source, entry);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(destination, entry), { recursive: true, dereference: false, filter: item => !fs.lstatSync(item).isSymbolicLink() });
}
// Recibos de geração de diagramas podem conter caminhos da máquina de origem.
const publicDocs = ['TECNICA.md', 'METRICAS.md', 'VALIDACAO.md', 'source-manifest.json', 'arquitetura.candidate.json', 'fluxo-ia.candidate.json', 'arquitetura.html', 'fluxo-ia.html'];
fs.mkdirSync(path.join(destination, 'docs'));
for (const name of publicDocs) {
  const from = path.join(source, 'docs', name);
  if (fs.existsSync(from) && fs.lstatSync(from).isFile() && !fs.lstatSync(from).isSymbolicLink()) fs.copyFileSync(from, path.join(destination, 'docs', name));
}
console.log(JSON.stringify({ installed: destination, runtime: 'Node >=22.13 com SQLite/FTS5', next: 'Na pasta instalada: node contexto.mjs setup --project RAIZ_DO_REPOSITORIO (uma vez); consulte INSTALL.md', data_copied: false, client_config_changed: false }));
