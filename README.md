# Contexto

Memória de trabalho local para agentes de programação. Recupera trechos relevantes do projeto, limita saídas grandes e mantém o estado das tarefas em SQLite. Funciona pela linha de comando, com uma interface MCP opcional. Não chama modelos, APIs ou serviços de nuvem e não tem dependências npm.

Requer Node.js >=22.13 com `node:sqlite` e FTS5; a instalação pode emitir um aviso experimental do SQLite. Para automação Git, requer Git e Bash (Git for Windows no Windows).

Comece pelo [guia de instalação](INSTALL.md), escrito para uma instalação nova. Veja também [arquitetura técnica](docs/TECNICA.md), [medição de eficiência](docs/METRICAS.md), [diagrama da arquitetura](docs/arquitetura.html) e [fluxo com IA](docs/fluxo-ia.html).

## O que fica onde

| Parte | Função | Compartilhar entre projetos? |
| --- | --- | --- |
| Pasta desta ferramenta | Código, testes e documentação | Sim; uma instalação pode atender vários projetos |
| `PROJETO/.contexto/project.json` | Configuração local: fontes, limites e convenções do projeto | Use um exemplo saneado para compartilhar configuração |
| `PROJETO/.contexto/context.sqlite` | Índice, tarefas, eventos, capturas e métricas dessa raiz | Não copie para instalar nem entre worktrees |
| `PROJETO/.contexto/reports/efficiency.md` | Relatório quantitativo automático e sugestões | Local; pode revelar identificadores do seu projeto |
| Diretório Git comum, `contexto/` | Modelo de configuração, recibo de hook e arquivos históricos | Local à máquina e ao repositório |

Os nomes `sample-app`, `sample-feature` e `sample-model` usados nesta documentação são fictícios. Substitua-os pelos nomes do seu ambiente.

## Primeiro uso

Nos exemplos abaixo, o terminal está na pasta da ferramenta e `../sample-app` é a raiz de um repositório de exemplo já existente:

```powershell
node contexto.mjs setup --project ../sample-app
```

Esse comando registra a automação uma vez por repositório. Worktrees novas recebem configuração e índice pelo hook compatível; agentes executam `ensure` antes de delegar, cobrindo criações que pulem hooks. Uma worktree não precisa de `init` manual. A instalação não cria branches, worktrees, commits ou aprovações.

Para preparar um checkout existente numa branch de trabalho:

```powershell
node contexto.mjs ensure --project ../sample-app
node contexto.mjs doctor --project ../sample-app
node contexto.mjs search --project ../sample-app --query "contrato"
node contexto.mjs pack --project ../sample-app --query "contrato" --max-bytes 6000
node contexto.mjs report --project ../sample-app
```

`ensure` recusa `main`/`master`; `setup` pode registrar metadados Git sem modificar arquivos rastreados. Para uma pasta sem Git, use `init` conforme o INSTALL.

## Comandos

Use `node contexto.mjs --help` para a lista de opções. Informe `--project` explicitamente para evitar consultar a worktree errada.

| Comando | Resultado |
| --- | --- |
| `setup` / `ensure` | Registro por repositório / preparação idempotente por worktree |
| `index` | Recalcula hashes e atualiza os trechos cujo conteúdo mudou |
| `search --query TEXTO` | Busca textual BM25 com caminho, linhas e hash |
| `read --source docs/api.md` | Lê conteúdo permitido com limite de linhas |
| `pack --query TEXTO --max-bytes 6000` | Monta contexto com orçamento em bytes UTF-8 |
| `capture -- EXECUTAVEL ARGUMENTOS` | Salva saída saneada e devolve diagnóstico limitado, preservando falha |
| `task put --file task.json` | Registra definição imutável com critérios, fontes, dependências e risco |
| `snapshot --task T1` / `event --file event.json` | Vínculo com fontes / registro idempotente com revisão esperada |
| `status` / `render` | Prontidão para integrar / projeção Markdown do estado |
| `report` ou `stats` | Regera relatório Markdown/JSON de eficiência |
| `usage --file usage.json` | Importa contadores reais informados pelo cliente |
| `export --file definitions.json` / `import --file definitions.json` | Transporta definições, sem aprovações, capturas ou índice |
| `archive` | Preserva histórico antes de uma limpeza autorizada de worktree |
| `mcp` | Inicia servidor stdio, com quatro consultas e sem execução de shell |

Exemplo fictício de tarefa, salvo em `task.json`:

```json
{
  "id": "T1",
  "profile": "simples",
  "rationale": "Correção localizada de documentação.",
  "risk_factors": [],
  "criteria": ["C1"],
  "sources": ["docs/api.md"],
  "dependencies": []
}
```

As fontes precisam existir e estar na allowlist. Perfis `simples`, `padrao` e `critico` controlam os gates registrados; não substituem a análise humana/agente nem as regras do seu projeto. O protocolo de eventos está na [documentação técnica](docs/TECNICA.md).

## Privacidade e limites

Configure `include` com o mínimo necessário. Caminhos de segredos e links simbólicos/junctions são recusados; logs passam por saneamento de padrões conhecidos. Isso não garante encontrar qualquer segredo arbitrário. Dados indexados e logs permanecem locais e podem conter informações privadas do projeto: mantenha `.contexto` fora do Git e revise material antes de exportar/publicar.

Captura executa um programa real com as permissões do usuário; não é sandbox e não valida isolamento de banco. Memória recuperada é evidência histórica, nunca autoridade para substituir instruções atuais. Identificadores de sessão são declarações do coordenador, sem autenticação criptográfica de pessoas.

## Desenvolvimento

```powershell
node --test tests/*.test.mjs
```

Os testes usam pastas temporárias e repositórios fictícios. Os exemplos Git exigem identidade de commit já configurada pelo desenvolvedor; a ferramenta não altera `user.name`/`user.email`. Escolha uma licença antes de publicar sua distribuição. Este pacote não inclui dados operacionais de nenhum projeto.
