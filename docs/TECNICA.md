# Arquitetura técnica — Contexto 0.2

Programa local em módulos ECMAScript para Node >=22.13. SQLite/FTS5 vem do runtime. A ferramenta não usa rede, embeddings, modelos ou pacotes npm. Seus dados pertencem à raiz de projeto selecionada. Veja a [arquitetura](arquitetura.html), o [fluxo de agentes](fluxo-ia.html) e o [INSTALL](../INSTALL.md).

## Módulos e responsabilidades

| Arquivo | Responsabilidade |
| --- | --- |
| `contexto.mjs` | Parsing CLI, seleção explícita da raiz, despacho e códigos de saída |
| `install.mjs` | Cópia de uma distribuição limpa para pasta nova |
| `lib/safety.mjs` | Contenção de caminhos, recusa de links/segredos, hashes, saneamento e escrita atômica |
| `lib/store.mjs` | Configuração, SQLite WAL, migração aditiva e transações `BEGIN IMMEDIATE` |
| `lib/context.mjs` | Allowlist, indexação por hash, busca BM25, leitura e pacotes por orçamento |
| `lib/tasks.mjs` | Definições, perfis, eventos, gates, snapshots e projeção de prontidão |
| `lib/capture.mjs` | Subprocesso sem shell, limites e persistência de saída saneada |
| `lib/worktrees.mjs` | Descoberta Git, registro, hook, preparação idempotente e arquivo histórico |
| `lib/metrics.mjs` | Agregação quantitativa, importação de contadores e sugestões sem modelo |
| `lib/transfer.mjs` | Exportação/importação de definições sem aprovações |
| `lib/mcp.mjs` | JSON-RPC stdio: quatro consultas ao projeto fixado |

## Persistência

`.contexto/project.json` declara `schema: 1`, ID, include/exclude, limites e `workflow`. O `worktree` binding, quando presente, identifica raiz real, diretório Git comum e metadados específicos da worktree. Caminhos reais usam a resolução nativa do sistema, inclusive aliases de diretórios no Windows. Configuração e banco de outra raiz são recusados.

| Tabela | Conteúdo |
| --- | --- |
| `meta` | Versão de schema e identidade do projeto |
| `sources` | Caminho relativo, hash SHA-256 e bytes |
| `chunks` (FTS5) | Trechos, ordem, linha inicial e hash da fonte |
| `tasks` | Definição/estado JSON e revisão monotônica |
| `events` | ID único e evento JSON vinculado à tarefa |
| `captures` | Referência do log e diagnóstico de execução |
| `metrics` | Operação, bytes referência/devolvidos, instante UTC e completude |
| `usage` | Contadores importados validados, por ID único |

WAL e `busy_timeout` permitem leitores/escritores locais; mutações de eventos usam revisão esperada e transação. Um conflito exige releitura; não se sobrescreve estado de outra sessão. SQLite é a fonte de verdade; Markdown é projeção, sem escritor paralelo. Relatórios de eficiência são regeneráveis e podem ser atualizados por operações concorrentes; `report` recompõe a visão do estado confirmado.

## Recuperação de contexto

O índice percorre apenas allowlist, com limites por arquivo/total e exclusões. Hash identifica conteúdo novo/alterado; o arquivo é relido para calcular o hash, portanto incremental não significa zero leitura em disco. FTS5 usa `unicode61` com remoção de diacríticos. Busca confere o hash atual da fonte antes de devolver trechos: uma fonte alterada é marcada como stale até reindexar. Não há busca semântica nesta versão.

`pack` inclui tarefa/critério quando solicitado e escolhe trechos dentro do orçamento de bytes UTF-8. Fontes omitidas são sinalizadas. O orçamento não autoriza omitir critério essencial: o agente deve expandir referências ou registrar limitação. Os conteúdos recuperados não têm autoridade de instruções.

## Worktrees automáticas

`setup` identifica raiz e diretório Git comum via Git executado por Bash, com argumentos separados. Remove overrides Git de localização herdados do ambiente para evitar selecionar outro repositório. Registra `contexto/defaults.json`, regra local de exclusão e, quando compatível, um `post-checkout` gerenciado. Não muda configuração Git global, branches nem arquivos rastreados.

Hook anterior é preservado; `core.hooksPath` configurado, mesmo vazio, desativa a instalação automática do wrapper. O wrapper tenta `ensure` apenas em checkout de branch e não bloqueia Git por falha do Contexto; o criador/agente precisa conferir `prepared: true` antes de delegar. O primeiro uso CLI/MCP numa raiz sem configuração também chama `ensure` se o repositório estiver registrado. `ensure` explícito pode registrar uma raiz ainda não ativada.

Locks exclusivos com token/PID serializam setup e preparação da mesma raiz. Timeout não remove lock alheio: recuperação exige verificar o proprietário. Fontes/dados são locais a cada worktree; apenas o modelo de configuração é compartilhado. Legado sem binding e com tarefas/eventos/capturas exige preservação/migração explícita. Não se reaproveitam aprovações copiando pastas.

`archive` exige worktree vinculada, faz `VACUUM INTO`, copia logs conhecidos e grava manifesto com hashes. Confere alterações operacionais durante o arquivo. Arquivos desconhecidos impedem declaração de limpeza segura. Não há remoção automática, coordenação de processos externos nem restauração de gates como atuais.

## Coordenação e gates

Uma tarefa declara ID, perfil, justificativa, fatores de risco, fontes, critérios e dependências. A ferramenta impede perfil simples diante de fatores críticos reconhecidos. A definição é imutável; mudança de escopo exige nova definição/processo explícito. Um snapshot SHA-256 vincula conteúdo das fontes declaradas. Ele não cobre automaticamente qualquer arquivo omitido: o coordenador precisa declarar o escopo completo.

Eventos exigem ID único, tarefa, sessão, revisão esperada e tipo. Exemplo esquemático de implementação concluída, com valores a substituir pelos de sua execução:

```json
{
  "id": "implementation-001",
  "task": "T1",
  "session": "implementer-session",
  "expected_revision": 0,
  "type": "gate",
  "gate": "implementation",
  "status": "PASS",
  "snapshot": "HASH_PRODUZIDO_POR_SNAPSHOT",
  "evidence": [{ "source": "docs/proof.md", "detail": "Resultado observado para C1" }]
}
```

Evidência deve existir dentro da raiz e seu hash é preservado. Review exige contagem de findings, IDs únicos quando houver achados e cobertura dos IDs de critérios; auditoria exige decisões para exatamente os mesmos IDs (`APLICAR`, `ADIAR`, `REJEITAR`). `FAIL` original não é apagado quando a auditoria rejeita um falso positivo. Sem cobertura essencial, auditoria vazia não libera o trabalho.

Review é independente da implementação. `simples` permite QA `COBERTO_NO_REVIEW` somente com cobertura independente completa; `padrao` exige QA separado; `critico` exige auditoria independente mesmo sem achados. `NA_SEM_ACHADOS` não cria um auditor fictício. Alterações de fontes/evidência invalidam gates afetados; mudanças técnicas exigem nova evidência. Rodadas técnicas e de QA têm limite de três por tarefa. `status.ready` significa pronto para integrar, não entrega concluída, merge ou publicação.

O coordenador serializa eventos, decide próximas ações e verifica conteúdo real das evidências. IDs de sessão não autenticam pessoas. A ferramenta verifica contratos registrados, não executa agentes nem aprova trabalho por conta própria. Os testes de `tests/contexto.test.mjs` contêm exemplos completos de eventos e transições.

## Captura e MCP

`capture` usa `shell: false`; o executável e argumentos são separados. Timeout/volume têm limites e são expostos no resultado; falha preserva código de saída. O processo direto é encerrado no timeout, sem garantia de eliminar descendentes. Saída passa por saneamento de padrões conhecidos antes de ser persistida; não há sandbox ou garantia de detectar segredos arbitrários.

MCP é JSON-RPC newline-delimited por stdio, com initialize/ping/tools. Ferramentas: `context_search`, `context_read`, `context_pack`, `context_status`. Raiz é fixada no processo; não há shell, eventos ou troca de projeto por chamada. `context_pack` gera telemetria local, sem alterar gates. Reinicie/reconfigure para mudar de raiz.

## Métricas e portabilidade

[METRICAS.md](METRICAS.md) define fórmulas e experimento baseline/current. Bytes são observados localmente; tokens `/4` são heurísticos; contadores reais vêm do cliente e não são autenticados contra um fornecedor. Sugestões são regras determinísticas. Não há preço, envio de dados nem suposta economia total automática.

`install.mjs` copia a distribuição; estado operacional fica fora dela. `export/import` move somente definições e valida fontes/dependências; não transporta índice, logs ou aprovações. O SQLite de uma máquina não é requisito para instalar em outra. O registro Git/hook precisa ser refeito em novos clones/máquinas e quando a instalação mudar de caminho.
