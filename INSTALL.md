# Instalação do Contexto

Este guia distingue três coisas: **instalar o programa**, **ativar um repositório** e **preparar uma worktree**. A primeira leva o mesmo código para a máquina; a segunda registra a automação daquele repositório; a terceira acontece automaticamente no fluxo do agente.

## 1. Preparar a máquina

Você precisa de Node.js >=22.13 com `node:sqlite`/FTS5, Git e Bash para a automação de worktrees. No Windows, o Bash normalmente vem com Git for Windows. Confira no terminal:

```powershell
node --version
git --version
```

O programa procura o Bash nas instalações usuais do Git for Windows; em sistemas Unix usa `/bin/bash`. Se o executável estiver em outro lugar, defina `CONTEXTO_BASH` com o caminho real dele. Não há `npm install`, conta, chave de API ou serviço de banco para configurar. SQLite é um arquivo criado localmente pelo Node.

## 2. Obter o código

Baixe/clone o repositório da ferramenta para uma pasta de sua escolha. A partir dela, já é possível usar `node contexto.mjs --help`. Não é necessário instalar uma cópia em cada projeto.

Se você já tem o código e quer uma segunda instalação limpa, execute da pasta original:

```powershell
node install.mjs --dest ../contexto-tools
```

O destino deve ser novo e ficar fora da instalação original. O instalador copia código, testes e documentação. Não instala Node/Git, não copia bancos, não altera clientes de IA nem configura repositórios. Entre na pasta nova para os próximos comandos:

```powershell
cd ../contexto-tools
node contexto.mjs --help
```

Os próximos exemplos consideram essa pasta como diretório atual. `../sample-app` representa um projeto Git existente; substitua esse argumento pelo caminho real do seu projeto, entre aspas se houver espaços.

## 3. Ativar cada repositório uma vez

```powershell
node contexto.mjs setup --project ../sample-app
```

`setup` descobre o diretório Git comum e grava nele um modelo de configuração. Acrescenta `/.contexto/` a `info/exclude` e instala um hook `post-checkout` quando compatível. Não altera o `.gitignore` rastreado nem cria `.contexto` no checkout principal. Leia o JSON devolvido: `registered: true` confirma o registro; `hook.automatic_hook` informa se o hook pode ser usado.

Se já existir um hook normal, ele é preservado e executado antes do Contexto, com seu código de saída respeitado. Se `core.hooksPath` estiver configurado, inclusive vazio, o Contexto preserva essa política e informa `automatic_hook: false`. Nesse caso, o agente/criador deve executar `ensure` automaticamente após criar ou reutilizar uma worktree. Não altere hooks gerenciados manualmente: a ferramenta recusa sobrescrever um hook que mudou fora dela.

Em um projeto com dois repositórios independentes, rode `setup` uma vez para cada raiz Git. Em outra máquina ou em um clone novo, repita `setup`: os metadados locais não são transportados pelo Git.

## 4. Preparação automática das worktrees

Depois do registro, uma criação Git normal aciona o hook. A worktree recebe sua própria `.contexto/project.json`, seu SQLite e seu índice. Isso não exige `init`. O estado de uma worktree não é copiado para outra.

Para tornar o fluxo robusto mesmo se a aplicação criadora desabilitar/pular hooks, inclua esta instrução nas suas regras de agentes ou no criador de worktrees:

> Depois de criar ou reutilizar uma worktree autorizada e antes de delegar trabalho, execute `node CAMINHO_DA_FERRAMENTA/contexto.mjs ensure --project RAIZ_DA_WORKTREE`. Confira `prepared: true`. Não copie `.contexto` de outra raiz. Repita na worktree de integração.

`CAMINHO_DA_FERRAMENTA` e `RAIZ_DA_WORKTREE` são marcadores a substituir por caminhos reais. Um exemplo com os diretórios fictícios deste guia:

```powershell
node contexto.mjs ensure --project ../sample-feature
```

O comando é idempotente: preserva configuração/tarefas existentes e atualiza o índice. Na primeira criação ele também registra o repositório se necessário. As consultas CLI/MCP conseguem preparar uma raiz ainda sem configuração se o repositório já estiver registrado. Clientes com processo MCP persistente devem usar um processo por raiz; um servidor não acompanha automaticamente a troca de worktree no editor.

`main` e `master` não recebem preparação automática. O hook ignora o checkout principal; um checkout principal numa branch de trabalho pode ser preparado explicitamente por `ensure`. Arquivos `.contexto` já rastreados, estado copiado de outra worktree e links simbólicos são recusados. A preparação não cria worktrees nem autoriza outras ações Git.

## 5. Escolher as fontes e convenções do projeto

Em uma branch de trabalho, prepare a raiz e confira o runtime:

```powershell
node contexto.mjs ensure --project ../sample-app
node contexto.mjs doctor --project ../sample-app
```

Edite `../sample-app/.contexto/project.json`. Preserve `schema`, `id` e a identidade `worktree`. Ajuste `include` para pastas relevantes e `exclude` para conteúdo desnecessário. Os caminhos de fontes são relativos à raiz preparada. Exemplo parcial:

```json
{
  "include": ["docs", "src", "tests", "README.md", "AGENTS.md"],
  "exclude": ["node_modules", "vendor", ".git", ".contexto", ".claude", ".agents", "dist", "build"],
  "maxFileBytes": 512000,
  "maxTotalBytes": 50000000
}
```

O objeto `workflow` orienta skills/agentes, sem executar automaticamente os comandos de validação do projeto. Você pode ajustar fuso, locais de planos/relatórios/entregas, regras e repositórios. Exemplo parcial de `workflow`:

```json
{
  "preset": "generic",
  "timezone": "UTC",
  "plansDir": "docs/planejamento/ia",
  "reportsDir": "docs/historico/reviews",
  "deliveryDir": "docs/historico/entregas",
  "rules": ["AGENTS.md"],
  "repositories": [{ "name": "sample-app", "root": ".", "layer": "app" }],
  "defaultProfile": "padrao",
  "reviewBranchPrefix": "revisao/",
  "worktreeDir": ".worktrees",
  "publish": "manual"
}
```

Após alterar a configuração, atualize explicitamente o modelo para **futuras** worktrees:

```powershell
node contexto.mjs setup --project ../sample-app --config-from ../sample-app
node contexto.mjs index --project ../sample-app
```

Worktrees já configuradas preservam suas opções. Caminhos operacionais de `workflow` são rebased para apontar à origem; fontes `include` continuam locais. Se `--config-from` apontar a um coordenador externo com vários repositórios, são herdadas convenções e a camada selecionada; a allowlist usa defaults locais, para não indexar pastas de outro produto por acidente.

## 6. Conferir o funcionamento e a economia

```powershell
node contexto.mjs search --project ../sample-app --query "contrato"
node contexto.mjs pack --project ../sample-app --query "contrato" --max-bytes 6000
node contexto.mjs report --project ../sample-app
```

Busca sem resultados pode significar que não há esse texto nos arquivos permitidos; verifique `include` e rode `index` depois de mudanças. Abra `../sample-app/.contexto/reports/efficiency.md`: `pack` e `capture` atualizam esse arquivo automaticamente. Ele apresenta bytes, estimativas, contadores importados e sugestões. Veja o [procedimento de comparação](docs/METRICAS.md) para medir tokens reais de trabalhos equivalentes. A ferramenta não lê automaticamente os históricos privados dos clientes de IA.

## 7. MCP opcional

CLI funciona sem MCP. Para usar um cliente compatível com MCP stdio, configure-o para executar `node` com os argumentos `CAMINHO_ABSOLUTO/contexto.mjs`, `mcp`, `--project`, `RAIZ_ABSOLUTA`. Exemplo de estrutura comum, a adaptar ao formato do seu cliente:

```json
{
  "mcpServers": {
    "contexto-sample": {
      "command": "node",
      "args": ["CAMINHO_ABSOLUTO/contexto.mjs", "mcp", "--project", "RAIZ_ABSOLUTA"]
    }
  }
}
```

Substitua os marcadores; use caminhos completos. O instalador não altera essa configuração. As ferramentas expostas são `context_search`, `context_read`, `context_pack` e `context_status`. São consultas ao projeto selecionado; não executam shell nem registram aprovações. `context_pack` pode atualizar as métricas locais de consulta.

## 8. Outra máquina, atualização e histórico

**Não precisa copiar `.contexto` ou SQLite para instalar em outra máquina.** Copie/clone somente o programa, execute `setup` em cada repositório e deixe as worktrees criarem seus dados. Índice é reconstruível. Para transportar definições de tarefas, use `export`/`import`; aprovações, capturas e histórico não são transportados por essa operação.

Para atualizar o programa, preserve os dados dos projetos e substitua apenas o código por uma versão validada. Se o caminho da instalação ou do executável Node mudou, execute `setup` de novo para atualizar o hook. Mudanças no modelo exigem `--config-from`; um `setup` comum preserva o modelo registrado.

Antes de remover uma worktree com histórico, pare os executores e execute `archive --project RAIZ`. O comando cria uma cópia SQLite consistente e copia logs conhecidos para o diretório Git comum. `cleanup_safe: false` indica arquivos desconhecidos que precisam ser preservados. Mesmo com `true`, o criador precisa comprovar ownership, árvore Git segura e ausência de processos antes de remover a worktree. `archive` não remove nada e não restaura aprovações como atuais.

Para desativar o hook, compare o hash em `contexto/hook.json` com o hook atual, no diretório Git comum indicado pelo `setup`. Só remova um wrapper reconhecido; se houver `post-checkout.contexto-original`, restaure esse arquivo como `post-checkout`. Se o conteúdo divergir, preserve e revise antes de editar. Não há desinstalador automático nesta versão. Mantenha os dados/históricos até decidir sua política de retenção.

## Problemas comuns

| Mensagem/situação | Ação |
| --- | --- |
| SQLite indisponível | Confira versão/distribuição Node e execute `doctor` |
| Bash não encontrado | Instale Git/Bash ou configure `CONTEXTO_BASH` |
| Não é raiz exata do repositório | Use a raiz que contém `.git`, não uma subpasta de código |
| `automatic_hook: false` | Mantenha o hook existente e integre `ensure` ao criador/agente |
| Preparação ocupada | Aguarde o processo proprietário; não apague lock sem conferir PID/execução |
| Estado pertence a outra worktree | Não reutilize a cópia; preserve o histórico e prepare uma raiz sem estado copiado |
| Métrica antiga excluída | Registros anteriores sem prova de captura completa ficam fora da redução |

O programa não realiza envio de telemetria. Nenhum percentual de redução é garantido: meça no seu trabalho e confira também qualidade e retrabalho.
