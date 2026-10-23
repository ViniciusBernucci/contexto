#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, VERSION, initialize } from './lib/store.mjs';
import { index, pack, read, search } from './lib/context.mjs';
import { capture, readCapture } from './lib/capture.mjs';
import { event, getTask, putTask, render, snapshot, status } from './lib/tasks.mjs';
import { exportProject, importProject } from './lib/transfer.mjs';
import { jsonFile, sanitize } from './lib/safety.mjs';
import { serve } from './lib/mcp.mjs';
import { archive, ensure, setup } from './lib/worktrees.mjs';
import { usage, writeReport, refreshReport } from './lib/metrics.mjs';

const help = `Contexto ${VERSION} — CLI local, sem rede ou dependências npm.
Requer Node >=22.13 com node:sqlite/FTS5. node:sqlite pode emitir aviso experimental.

node contexto.mjs COMANDO [--project RAIZ] [opções]
  init --name ID [--preset generic]      Inicializa .contexto/ e gitignore
  setup [--config-from RAIZ]             Ativa herança/hook uma vez por repositório
  ensure [--config-from RAIZ]            Prepara/reindexa worktree automaticamente
  archive                               Preserva estado antes de remover worktree
  doctor                                 Confere runtime e banco
  index                                  Reindexa somente conteúdo alterado
  search --query TEXTO [--limit 5]         Busca com referências e hash
  read --source CAMINHO [--start 1 --lines 60]
  read --capture ID                       Consulta log saneado
  pack [--task ID --role reviewer --query TEXTO --max-bytes 10000]
  task put --file JSON                    Cria tarefa com perfil e critérios
  task get --task ID                      Lê definição e gates
  snapshot --task ID                      Calcula snapshot dos arquivos declarados
  event --file JSON                       Registra evento idempotente/CAS
  status [--task ID]                      Prontidão para integrar; não entrega final
  render                                 Gera .contexto/generated/status.md
  capture [--timeout 30000 --max-bytes 2000000] -- EXECUTAVEL ARGUMENTOS
  export --file DESTINO                   Exporta definições; sem aprovações/logs
  import --file ORIGEM                    Importa sem sobrescrever; requer fontes
  stats / report                         Relatório quantitativo e sugestões locais
  usage --file JSON                      Importa tokens reais baseline/current
  mcp                                    MCP stdio com quatro ferramentas de consulta

Use --project explicitamente ao trabalhar com worktrees. Captura não é sandbox.
Orçamentos são bytes UTF-8; estatísticas não equivalem a tokens faturados.
`;
function parse(argv) {
  const options = {}, positional = []; let command = [];
  for (let number = 0; number < argv.length; number++) {
    const value = argv[number];
    if (value === '--') { command = argv.slice(number + 1); break; }
    if (value.startsWith('--')) {
      if (value === '--help') options.help = true;
      else if (value === '--from-hook') options.fromHook = true;
      else {
        const key = value.slice(2);
        if (!['project', 'name', 'preset', 'config-from', 'query', 'limit', 'source', 'start', 'lines', 'capture', 'task', 'role', 'max-bytes', 'file', 'timeout'].includes(key)) throw Error(`Opção desconhecida: ${value}`);
        if (!argv[number + 1] || argv[number + 1].startsWith('--')) throw Error(`Valor ausente: ${value}`);
        options[key] = argv[++number];
      }
    } else positional.push(value);
  }
  return { options, positional, command };
}
export async function main(argv = process.argv.slice(2)) {
  const { options, positional, command } = parse(argv);
  if (options.help || !positional.length) { process.stdout.write(help); return 0; }
  const root = path.resolve(options.project || process.cwd());
  const [operation, subcommand] = positional;
  if (operation === 'init') { console.log(JSON.stringify(initialize(root, options.name, options.preset))); return 0; }
  if (operation === 'setup') { console.log(JSON.stringify(setup(root, { configFrom: options['config-from'] }))); return 0; }
  if (operation === 'ensure') { console.log(JSON.stringify(ensure(root, { configFrom: options['config-from'], fromHook: options.fromHook }))); return 0; }
  if (operation === 'archive') { console.log(JSON.stringify(archive(root))); return 0; }
  if (!fs.existsSync(path.join(root, '.contexto/project.json'))) ensure(root, { onlyRegistered: true });
  const store = new Store(root);
  let result;
  try {
    if (operation === 'mcp') { await serve(store); return 0; }
    const number = (key, fallback) => options[key] === undefined ? fallback : Number(options[key]);
    switch (operation) {
      case 'doctor': {
        const [major, minor] = process.versions.node.split('.').map(Number);
        if (major < 22 || (major === 22 && minor < 13)) throw Error('Node >=22.13 obrigatório');
        store.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.fts_probe USING fts5(body)');
        result = { ok: true, version: VERSION, node: process.versions.node, sqlite: store.db.prepare('SELECT sqlite_version() AS version').get().version, fts5: true, project: store.config.id, root: store.root, network: false, llm: false }; break;
      }
      case 'index': result = index(store); break;
      case 'search': result = search(store, options.query, number('limit', 5)); break;
      case 'read': result = options.capture ? readCapture(store, options.capture) : read(store, options.source, number('start', 1), number('lines', 60)); break;
      case 'pack': result = pack(store, { task: options.task, role: options.role, query: options.query, maxBytes: number('max-bytes', 10000) }); break;
      case 'task':
        if (subcommand === 'put') result = putTask(store, jsonFile(options.file));
        else if (subcommand === 'get') result = getTask(store, options.task);
        else throw Error('Use task put ou task get');
        break;
      case 'snapshot': result = { task: options.task, snapshot: snapshot(store, options.task) }; break;
      case 'event': result = event(store, jsonFile(options.file)); break;
      case 'status': result = status(store, options.task); break;
      case 'render': result = render(store); break;
      case 'capture': result = await capture(store, command, { timeout: number('timeout', 30000), maxBytes: number('max-bytes', 2000000) }); break;
      case 'export': if (!options.file) throw Error('--file obrigatório'); result = exportProject(store, path.resolve(options.file)); break;
      case 'import': if (!options.file) throw Error('--file obrigatório'); result = importProject(store, path.resolve(options.file)); break;
      case 'usage': result = usage(store, jsonFile(options.file)); refreshReport(store); break;
      case 'stats': case 'report': result = writeReport(store); break;
      default: throw Error('Comando desconhecido; use --help');
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    return operation === 'capture' && !result.success ? (result.exit_code > 0 && result.exit_code < 256 ? result.exit_code : 1) : 0;
  } finally { store.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(JSON.stringify({ error: sanitize(error.message) }) + '\n'); process.exitCode = 1; });
}
