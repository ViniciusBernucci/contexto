# Tutorial: instalar o Contexto em uma VPS com backend e frontend

Este tutorial usa os dois repositórios informados: `proEnemBackLaravel` e `proEnemfrontWeb`. O objetivo é instalar **uma cópia do Contexto na VPS**, ativar os dois repositórios e deixar cada worktree com seus próprios dados, sem precisar executar `init` em cada uma.

Os nomes dos projetos são exemplos do cenário solicitado; não há IP, credencial ou caminho privado de servidor neste documento.

## 1. Entenda o que será instalado

O Contexto é um programa executado pelo Node.js. Ele lê arquivos permitidos do projeto, monta um índice de busca, prepara pacotes pequenos de contexto e registra métricas. Seu banco SQLite é um arquivo local: não é o banco de dados da aplicação Laravel.

| Item | Onde ficará | Para que serve |
| --- | --- | --- |
| Programa Contexto | Pasta `contexto`, ao lado dos repositórios | Uma instalação atende aos dois projetos |
| Registro de automação | Diretório Git comum de cada repositório | Guarda configuração padrão, exclusão local e hook compatível |
| Dados da worktree | `.contexto` dentro de cada worktree | Configuração, índice, tarefas e métricas daquela raiz |
| Relatório de eficiência | `.contexto/reports/efficiency.md` | Mostra medições e sugestões locais |

Não precisa instalar PHP, Composer, dependências do frontend, servidor SQLite ou pacotes npm para usar o Contexto. Também não precisa abrir porta, configurar domínio, criar serviço systemd ou deixar um servidor web do Contexto rodando.

Os comandos deste guia não incluem migrations, testes Laravel, build, deploy ou reinicialização de serviços. Hooks Git existentes continuam sendo executados e podem ter seus próprios efeitos, como explicado na etapa 10. A validação será feita em worktrees novas, preservando a branch ativa dos checkouts originais.

## 2. Saiba em qual computador executar cada comando

**Quase todos os comandos são para o terminal da VPS, em Bash.** O único bloco marcado como PowerShell é uma alternativa para enviar o programa do seu computador Windows.

Se você já está conectado pelo VS Code Remote SSH, como na imagem do cenário:

1. Confira que a janela indica uma conexão SSH.
2. Abra **Terminal → Novo Terminal** nessa janela.
3. No terminal, execute:

```bash
hostname
whoami
pwd
```

`hostname` identifica a máquina, `whoami` mostra o usuário e `pwd` mostra a pasta atual. Não publique essas saídas se contiverem informações privadas.

Use o usuário que normalmente trabalha nesses repositórios e consegue escrever em seus metadados Git. Evite executar o Contexto com `sudo`: isso pode criar arquivos pertencentes a outro usuário. Se os repositórios pertencem a outra conta, peça ao responsável da VPS para indicar o usuário correto; não resolva isso com `chmod 777` ou troca recursiva de proprietário.

O terminal aberto por uma conexão Remote SSH roda na máquina remota, conforme a [documentação do VS Code](https://code.visualstudio.com/docs/remote/ssh).

Para garantir que os exemplos seguintes sejam interpretados por Bash, execute uma vez:

```bash
bash
```

Mantenha esse terminal aberto durante o tutorial. Ao abrir outro terminal, as variáveis que vamos definir precisam ser definidas novamente.

## 3. Descubra a pasta que contém os dois repositórios

A imagem não informa o caminho absoluto da pasta pai. Não vamos presumir que ela fica em `/root`, `/var/www` ou em uma pasta específica de usuário.

No explorador do VS Code, use **Copiar Caminho** na pasta que contém os dois projetos. No terminal da VPS, entre nela, substituindo o texto abaixo pelo caminho copiado:

```bash
cd '/CAMINHO/REAL/DA/PASTA/PAI'
pwd
ls -d -- */
```

Você deve encontrar as duas pastas. O desenho esperado é:

```text
pasta-pai/
├── backups/
├── documentacoes/
├── proEnemBackLaravel/
└── proEnemfrontWeb/
```

**No Linux, letras maiúsculas e minúsculas fazem diferença.** Se o nome real for `proEnemFrontWeb`, por exemplo, use exatamente essa escrita nos comandos. Não renomeie a pasta para seguir o exemplo.

Defina os caminhos para não precisar digitá-los várias vezes:

```bash
PROJETOS="$(pwd -P)"
BACK="$PROJETOS/proEnemBackLaravel"
FRONT="$PROJETOS/proEnemfrontWeb"
CONTEXTO="$PROJETOS/contexto"

printf 'Pasta pai: %s\nBackend: %s\nFrontend: %s\nFerramenta: %s\n' "$PROJETOS" "$BACK" "$FRONT" "$CONTEXTO"
```

Essas variáveis são atalhos válidos apenas neste terminal. Se a grafia de um repositório for diferente, corrija a linha correspondente antes de continuar.

Confira as pastas e as raízes Git, um repositório por comando:

```bash
ls -ld -- "$BACK" "$FRONT"
git -C "$BACK" rev-parse --show-toplevel
git -C "$FRONT" rev-parse --show-toplevel
```

Cada comando Git deve mostrar a raiz do respectivo repositório, sem erro. Se apontar para uma pasta superior ou retornar `not a git repository`, pare e corrija o caminho.

## 4. Confira o sistema e os programas necessários

```bash
cat /etc/os-release
git --version
bash --version
command -v curl
command -v node
```

Os passos de instalação de pacotes abaixo consideram **Ubuntu ou Debian**. Se `/etc/os-release` indicar outra distribuição, use o gerenciador dela com ajuda do administrador. Não execute comandos `apt-get` em outro sistema.

Se Git, Bash ou curl estiverem ausentes, instale os utilitários nesta etapa:

```bash
sudo apt-get update
sudo apt-get install --no-install-recommends git bash curl ca-certificates tar gzip xz-utils
```

`sudo` pode pedir a senha do seu usuário; ela não aparece enquanto você digita. Se sua conta não tem permissão, peça ao administrador para instalar esses utilitários. Este guia não pede atualização geral do sistema nem substituição do Node usado pelas aplicações.

Confira também o suporte Git usado pelo Contexto:

```bash
git -C "$BACK" rev-parse --path-format=absolute --git-common-dir
git -C "$FRONT" rev-parse --path-format=absolute --git-common-dir
```

O resultado deve ser um caminho absoluto para os metadados Git de cada repositório. Se a versão de Git não reconhecer essa opção, ela precisa ser atualizada antes do `setup`.

## 5. Escolha o Node que executará o Contexto

O Contexto requer Node >=22.13 com SQLite/FTS5. Vamos guardar o caminho completo do executável em `CONTEXTO_NODE`. Assim os próximos comandos não dependem do Node usado para executar ou compilar o frontend.

### Opção A: já existe um Node compatível

Se `command -v node` mostrou um executável, confira:

```bash
node --version
```

Se ele for compatível, defina:

```bash
CONTEXTO_NODE="$(node -p 'process.execPath')"
```

Siga para o teste de SQLite na etapa 6. Se o teste falhar ou o Node for antigo, use a opção B.

### Opção B: instalar um Node separado para a ferramenta

Esta opção usa uma instalação própria do nvm dentro da sua pasta pessoal. Ela não substitui `/usr/bin/node` e não modifica os arquivos de inicialização do seu shell, pois o instalador receberá `PROFILE=/dev/null`. O carregamento do nvm abaixo altera somente a sessão atual. A forma de instalação e essa opção de perfil são documentadas no [projeto oficial nvm](https://github.com/nvm-sh/nvm/blob/v0.40.4/README.md).

Execute cada comando e confira se termina sem erro antes do próximo:

```bash
mkdir -p "$HOME/.local/share/contexto-runtime"
export NVM_DIR="$HOME/.local/share/contexto-runtime/nvm"
mkdir -p "$NVM_DIR"
```

Baixe o instalador oficial para um arquivo, em vez de executar conteúdo baixado diretamente em um pipe:

```bash
curl -fSL 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh' -o "$HOME/.local/share/contexto-runtime/install-nvm.sh"
```

O exemplo fixa nvm `v0.40.4` para tornar os passos reproduzíveis; não afirma que essa é a versão mais recente. Se o download falhar, não execute um arquivo parcial. Resolva o acesso HTTPS e repita o download com sucesso.

Instale e carregue o nvm dessa pasta:

```bash
PROFILE=/dev/null bash "$HOME/.local/share/contexto-runtime/install-nvm.sh"
. "$NVM_DIR/nvm.sh"
nvm --version
```

Instale a linha 22 do Node e guarde o executável real:

```bash
nvm install 22
CONTEXTO_NODE="$(node -p 'process.execPath')"
"$CONTEXTO_NODE" --version
```

O nvm baixa o patch disponível da linha 22. Não execute `nvm alias default`, não altere o Node do serviço da aplicação e não rode `sudo npm install` para instalar o Contexto.

Se fechar este terminal antes de salvar os caminhos na etapa 8, recupere esse Node em um novo Bash com:

```bash
export NVM_DIR="$HOME/.local/share/contexto-runtime/nvm"
. "$NVM_DIR/nvm.sh"
nvm use 22
CONTEXTO_NODE="$(node -p 'process.execPath')"
```

## 6. Teste o SQLite sem tocar no banco da aplicação

Execute este teste em memória:

```bash
"$CONTEXTO_NODE" --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const probe = new DatabaseSync(":memory:"); probe.exec("CREATE VIRTUAL TABLE probe USING fts5(body)"); console.log("OK: Node, SQLite e FTS5 disponíveis"); probe.close();'
```

Resultado esperado:

```text
OK: Node, SQLite e FTS5 disponíveis
```

Um aviso `ExperimentalWarning` pode aparecer na linha 22 e não significa, sozinho, que o teste falhou. Um erro de importação ou de FTS5 precisa ser resolvido antes de seguir. O módulo é fornecido pelo [próprio Node.js](https://nodejs.org/download/release/v22.20.0/docs/api/sqlite.html); não precisa instalar um servidor SQLite.

## 7. Coloque o programa Contexto na VPS

Escolha **uma** das alternativas. O resultado precisa ser uma pasta `$CONTEXTO` contendo diretamente `contexto.mjs`, `install.mjs`, `package.json` e `lib/`, sem outra pasta `contexto` por dentro.

### Alternativa A: clonar o repositório exclusivo da ferramenta

Use esta opção quando seu repositório Contexto já existir no GitHub ou em outro serviço Git. Pegue a URL real em **Code → HTTPS** ou **SSH**. No terminal da VPS, substitua o marcador:

```bash
URL_CONTEXTO='COLE_AQUI_A_URL_REAL_DO_REPOSITORIO_CONTEXTO'
git clone "$URL_CONTEXTO" "$CONTEXTO"
```

Não execute o exemplo sem trocar a URL. Para repositório privado, use o método de autenticação já autorizado na VPS; não coloque token ou senha na URL, no tutorial ou nos arquivos do projeto.

Se a pasta de destino já existe, não a apague nem force o clone. Confira se ela já contém uma instalação válida e continue a partir dela, ou escolha um novo destino e atualize a variável `CONTEXTO`.

### Alternativa B: enviar uma cópia limpa do computador Windows

Use esta opção se o projeto exclusivo ainda não estiver publicado. Primeiro, **no PowerShell do computador Windows**, entre na pasta local que contém o código do Contexto. Substitua o caminho:

```powershell
Set-Location 'C:\CAMINHO\LOCAL\DA\FERRAMENTA\contexto'
node install.mjs --dest "$env:TEMP/contexto-envio-vps"
```

O destino deve ser novo. Se já existir, escolha outro nome e use-o também no próximo comando. O instalador copia a distribuição e não copia os dados `.contexto` dos seus projetos.

Envie a pasta criada, ainda **no PowerShell local**:

```powershell
scp -r "$env:TEMP/contexto-envio-vps" 'USUARIO@HOST:/CAMINHO/ABSOLUTO/DA/PASTA/PAI/contexto'
```

Substitua `USUARIO`, `HOST` e o caminho pelo acesso real da sua VPS e pelo valor de `PROJETOS` encontrado na etapa 3. A pasta `contexto` de destino ainda não deve existir para essa forma de cópia. Se usar um alias SSH já configurado no seu computador, ele pode substituir `USUARIO@HOST`. Uma porta SSH diferente da padrão exige acrescentar `-P NUMERO` ao `scp`.

Esse comando copia arquivos. Não execute `init` no Windows para tentar configurar a VPS: os caminhos e metadados são diferentes em cada máquina.

### Confira o resultado no terminal da VPS

Volte ao **Bash remoto**:

```bash
ls -l -- "$CONTEXTO/contexto.mjs" "$CONTEXTO/install.mjs" "$CONTEXTO/package.json"
ls -ld -- "$CONTEXTO/lib"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" --help
```

Você deve ver a ajuda do Contexto. Não precisa executar `npm install`, `npm run build` ou `composer install`.

## 8. Salve os atalhos dos caminhos para os próximos acessos

Vamos criar um arquivo pessoal com os caminhos que você já conferiu. Ele não ficará dentro dos repositórios. Use um nome livre: o bloco abaixo recusa sobrescrever um arquivo existente.

```bash
CONTEXTO_AMBIENTE="$HOME/.config/contexto/vps.env.sh"
mkdir -p "$HOME/.config/contexto"
(
  set -o noclobber
  umask 077
  printf 'export PROJETOS=%q\nexport BACK=%q\nexport FRONT=%q\nexport CONTEXTO=%q\nexport CONTEXTO_NODE=%q\n' \
    "$PROJETOS" "$BACK" "$FRONT" "$CONTEXTO" "$CONTEXTO_NODE" > "$CONTEXTO_AMBIENTE"
)
```

Se informar que o arquivo já existe, abra-o e confira os caminhos; não o sobrescreva sem revisar. Em outro terminal Bash da mesma VPS e do mesmo usuário, recupere os atalhos com:

```bash
source "$HOME/.config/contexto/vps.env.sh"
"$CONTEXTO_NODE" --version
```

Isso funciona mesmo sem carregar o nvm, porque salvamos o caminho completo do executável Node. O arquivo contém caminhos, não precisa conter senha ou token. Se mover a ferramenta ou atualizar para outro executável Node, revise esses valores e rode `setup` novamente para atualizar os hooks.

## 9. Registre o estado atual dos dois repositórios

Antes da ativação, confira branch e alterações existentes:

```bash
git -C "$BACK" branch --show-current
git -C "$BACK" status --short
```

Depois, confira o outro repositório:

```bash
git -C "$FRONT" branch --show-current
git -C "$FRONT" status --short
```

Saída vazia de `status --short` significa que não há alterações visíveis nesse formato. Se houver alterações, anote-as; não faça reset, limpeza ou checkout forçado. O `setup` escreve metadados locais e não exige trocar a branch desses checkouts.

## 10. Ative o backend e o frontend, uma vez por repositório

Ative primeiro o backend:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" setup --project "$BACK"
```

Depois, ative o frontend:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" setup --project "$FRONT"
```

Cada comando deve terminar sem erro e devolver um JSON com `registered: true` e `tracked_files_changed: false`.

O registro tem três efeitos: salva um modelo de configuração no diretório Git comum, exclui `.contexto/` pelo `info/exclude` local e instala um hook `post-checkout` quando compatível. Ele não cria configuração operacional no checkout principal nem troca sua branch.

Confira o campo `hook.automatic_hook`:

| Resultado | Significado | Próximo passo |
| --- | --- | --- |
| `true` | O hook compatível foi instalado | Criações Git normais podem preparar as worktrees automaticamente |
| `false` com `custom-hooks-path` | Já existe uma política `core.hooksPath`, inclusive possivelmente vazia | Preserve-a; o agente/criador executará `ensure` automaticamente antes de usar a worktree |

Hook anterior normal é preservado e executado primeiro. Uma falha dele continua sendo falha. Não desative hooks de deploy/segurança para obter `automatic_hook: true`. Antes da etapa 11, confira com o responsável do projeto se os hooks existentes podem rodar em uma worktree de conferência: `git worktree add` faz checkout e pode acionar esses hooks, inclusive scripts de deploy que já estivessem configurados.

`setup` pode registrar metadados com o checkout em `main` ou `master`. Já `ensure` recusa essas branches. Portanto, não tente resolver essa recusa trocando a branch da aplicação em funcionamento: use uma worktree de trabalho separada.

## 11. Crie duas worktrees para conferir a instalação

Uma worktree é outra pasta do mesmo repositório, com seu próprio checkout e branch. Ela permite validar o Contexto sem mudar a branch da pasta original servida pela VPS. Não é um clone separado: compartilha o histórico e os metadados Git comuns.

Se seu agente já criou worktrees autorizadas para uma tarefa, você pode usar aquelas raízes nos próximos passos, conferindo-as antes. Para uma conferência inicial isolada, os comandos abaixo criam branches e pastas novas; não iniciam as aplicações.

Defina nomes específicos desta execução:

```bash
DATA_TUTORIAL="$(date +%Y%m%d-%H%M%S)"
BRANCH_TUTORIAL="chore/contexto-vps-$DATA_TUTORIAL"
PASTA_WORKTREES="$PROJETOS/worktrees-contexto-vps/$DATA_TUTORIAL"
WT_BACK="$PASTA_WORKTREES/backend"
WT_FRONT="$PASTA_WORKTREES/frontend"
mkdir -p "$PASTA_WORKTREES"
```

Crie a do backend a partir do commit atualmente selecionado nele:

```bash
git -C "$BACK" worktree add -b "$BRANCH_TUTORIAL" "$WT_BACK" HEAD
```

Crie a do frontend a partir do commit atualmente selecionado nele:

```bash
git -C "$FRONT" worktree add -b "$BRANCH_TUTORIAL" "$WT_FRONT" HEAD
```

O mesmo nome de branch nos dois repositórios não causa conflito, pois são repositórios independentes. Alterações ainda não commitadas nos checkouts originais não são copiadas para essas worktrees.

Se uma pasta ou branch já existir, não use `--force`. Confira o que já existe e escolha um novo conjunto de nomes, ou reutilize somente uma worktree cuja finalidade e ausência de outro executor tenham sido comprovadas.

## 12. Confira a preparação e o banco de cada worktree

Execute `ensure` nas duas raízes. Ele também é o passo que seu agente deve fazer no futuro, mesmo quando o hook já preparou a pasta:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" ensure --project "$WT_BACK"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" ensure --project "$WT_FRONT"
```

Espere `prepared: true`. `created: false` é normal quando o hook já fez a preparação. O comando preserva a configuração existente e atualiza o índice. Você não executou `init` em nenhuma dessas worktrees.

Confira o runtime e os bancos:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" doctor --project "$WT_BACK"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" doctor --project "$WT_FRONT"
ls -l -- "$WT_BACK/.contexto/context.sqlite" "$WT_FRONT/.contexto/context.sqlite"
```

`doctor` deve informar `ok: true`, `fts5: true` e a raiz correta. Os arquivos SQLite devem estar em **pastas diferentes**. O índice, tarefas, aprovações e métricas de um projeto não são compartilhados automaticamente com o outro.

Confira também que os dados foram ignorados:

```bash
git -C "$WT_BACK" check-ignore .contexto/project.json
git -C "$WT_FRONT" check-ignore .contexto/project.json
git -C "$WT_BACK" status --short
git -C "$WT_FRONT" status --short
```

Os dois primeiros comandos devem indicar `.contexto/project.json`. Para uma worktree nova sem outros hooks que produzam arquivos, os dois últimos devem estar vazios. Se aparecer trabalho criado por outro hook, investigue sem apagar; o Contexto não descarta esses arquivos.

## 13. Veja quais arquivos entram no índice

Abra no VS Code os arquivos:

```text
worktrees-contexto-vps/DATA-DA-EXECUCAO/backend/.contexto/project.json
worktrees-contexto-vps/DATA-DA-EXECUCAO/frontend/.contexto/project.json
```

Use os caminhos reais impressos por `ensure`, não o marcador `DATA-DA-EXECUCAO`. As pastas iniciadas por ponto podem estar ocultas na configuração do seu explorador.

Os defaults incluem `app`, `routes`, `src`, `tests`, `docs` e arquivos de regras/documentação selecionados, quando presentes. Ignoram dependências e várias pastas geradas. Isso já permite começar nos dois repositórios sem alterar configurações.

Para personalizar somente a worktree atual, edite **apenas** `include`/`exclude`, preservando os demais campos, especialmente `id`, `schema` e `worktree`. Exemplos de fontes:

- Backend: `app`, `routes`, `tests`, `docs`, `README.md`; acrescente `database` se quiser consultar o código das migrations, sem executá-las.
- Frontend: `src`, `tests`, `docs`, `README.md`.
- Evite incluir a pasta pai inteira, `backups`, uploads, logs, dumps ou dependências. Não inclua `.env`, chaves privadas ou arquivos de credenciais.

Depois de editar uma configuração local, reindexe a raiz correspondente:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" index --project "$WT_BACK"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" index --project "$WT_FRONT"
```

Essa edição local não atualiza o modelo de todas as futuras worktrees. Se quiser personalizar o modelo deste repositório, o `setup` devolve o caminho `common`; dentro dele está `contexto/defaults.json`. Em uma janela de manutenção, com outros `setup`/`ensure` parados, abra esse JSON pelo editor, preserve `schema`, `common` e `sourceRoot` e ajuste somente `config.include`, `config.exclude` ou as convenções em `config.workflow`. Salve JSON válido. Um `setup` comum preserva esse modelo; futuras preparações o usam, enquanto worktrees já configuradas preservam suas opções. Não substitua o registro pelo JSON de uma worktree nem copie bancos para distribuir configurações.

Para esta primeira instalação, essa personalização do modelo é opcional: mantenha os defaults se não souber o que mudar. O [INSTALL](INSTALL.md) explica também configuração de origem e coordenadores com vários repositórios.

## 14. Faça uma primeira consulta nos dois projetos

Backend:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" search --project "$WT_BACK" --query 'controller'
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" pack --project "$WT_BACK" --query 'controller' --max-bytes 6000
```

Frontend:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" search --project "$WT_FRONT" --query 'component'
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" pack --project "$WT_FRONT" --query 'component' --max-bytes 6000
```

Esses termos são exemplos, não afirmações sobre a estrutura do seu frontend. Uma busca vazia não significa instalação quebrada: experimente uma palavra que realmente apareça em um arquivo permitido e reindexe depois de mudanças. O Contexto faz busca textual, não uma conversa com um modelo.

`search` devolve referências; `pack` monta um pacote com orçamento em bytes. Ter a ferramenta instalada não faz o cliente de IA consumir esses pacotes automaticamente: o agente precisa usar a CLI ou a integração MCP.

## 15. Deixe seu fluxo de IA preparar as próximas worktrees

Esta é a parte que evita trabalho manual em cada criação. Existem dois mecanismos complementares:

1. Hook compatível: tenta preparar após o checkout de uma nova worktree criada normalmente pelo Git.
2. Regra do agente/criador: executa `ensure` após criar **ou reutilizar** a pasta e antes de delegar a tarefa. Cobre hooks desativados, `core.hooksPath` customizado e gerenciadores que pulam hooks.

Inclua a instrução abaixo nas regras que o seu coordenador/agente realmente carrega para esse projeto. Preserve regras existentes; não sobrescreva um `AGENTS.md`, `CLAUDE.md` ou configuração global inteira. Use os caminhos absolutos reais exibidos por:

```bash
printf 'Executavel Node: %s\nCLI Contexto: %s/contexto.mjs\nBackend: %s\nFrontend: %s\n' "$CONTEXTO_NODE" "$CONTEXTO" "$BACK" "$FRONT"
```

Texto para adaptar e acrescentar às instruções do fluxo:

```text
Contexto está instalado nesta VPS em CAMINHO_ABSOLUTO/contexto.mjs,
executado com NODE_ABSOLUTO. Estes são os caminhos Linux desta máquina.

Depois de criar ou reutilizar uma worktree autorizada, inclusive integração,
execute automaticamente, na VPS:
"NODE_ABSOLUTO" "CAMINHO_ABSOLUTO/contexto.mjs" ensure --project "RAIZ_REAL_DA_WORKTREE"

Confira exit code 0, prepared:true, raiz correta e banco isolado antes de delegar.
Não peça init manual ao usuário. Não copie .contexto entre worktrees.
Respeite as regras existentes para Git, testes, banco e deploy.

Use search/read/pack na raiz selecionada e consulte arquivos por referência.
Antes da limpeza autorizada, sem executores ativos, execute archive nessa raiz.
Archive não autoriza remover worktree nem descartar trabalho desconhecido.
```

Troque os marcadores antes de entregar a instrução ao agente. As variáveis deste terminal não são necessariamente herdadas pelo cliente de IA; caminhos absolutos deixam isso explícito.

Se suas skills foram copiadas separadamente e usam o helper `preparar-contexto.mjs`, a ferramenta não precisa estar ao lado delas: configure `CONTEXTO_CLI` no ambiente do executor para o caminho real de `contexto.mjs`. O helper pertence ao pacote de skills, não é instalado pelo Contexto. Não importe regras específicas de outro produto para esta VPS.

**Resultado esperado:** você pede uma tarefa ao fluxo, o criador autorizado abre/reaproveita a worktree e o agente a prepara. O usuário não roda `init` em cada pasta. Ativar Contexto não instala o cliente de IA nem as skills do planejamento/orquestração por conta própria.

## 16. Leia as métricas de economia

Gere ou atualize os relatórios das raízes usadas:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" report --project "$WT_BACK"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" report --project "$WT_FRONT"
```

Para ler no terminal:

```bash
cat "$WT_BACK/.contexto/reports/efficiency.md"
cat "$WT_FRONT/.contexto/reports/efficiency.md"
```

Ou abra esses arquivos Markdown pelo VS Code. `pack` e `capture` atualizam as projeções automaticamente. Os relatórios mostram bytes, estimativa de tokens, quantidade de amostras e sugestões locais sem chamadas a modelos.

As consultas de demonstração também entram nas métricas dessas worktrees de conferência; não as apresente como economia de um lote real. Estimativa de tokens não equivale a faturamento. A comparação real exige contadores do cliente para trabalhos equivalentes, incluindo todos os agentes e correções. Veja [METRICAS.md](docs/METRICAS.md).

Cada worktree tem seu relatório. Nesta versão não existe um consolidado automático dos dois repositórios ou de todas as worktrees.

## 17. MCP é opcional e precisa rodar no lugar certo

A instalação já funciona por CLI. Se quiser MCP, siga a seção correspondente do [INSTALL](INSTALL.md) usando o formato aceito pelo seu cliente. O processo deve executar o Node e a CLI **na VPS**, com a raiz Linux da worktree selecionada.

Um cliente executando localmente no Windows não consegue iniciar `/home/.../node` diretamente. Uma janela Remote SSH não garante que todo cliente/plugin de IA tenha mudado sua execução para o servidor: confira onde o cliente executa ferramentas. Comece pela CLI remota se não souber configurar essa integração.

O MCP é stdio, sem porta HTTP para abrir. Cada processo fica preso à raiz selecionada; backend e frontend/worktrees distintas exigem processos separados ou reconfiguração/reinício no cliente. Não use o MCP de um projeto como se consultasse o banco do outro.

## 18. Confira que as aplicações originais continuam na mesma branch

Releia branch e status, comparando com a etapa 9:

```bash
git -C "$BACK" branch --show-current
git -C "$BACK" status --short
```

Depois:

```bash
git -C "$FRONT" branch --show-current
git -C "$FRONT" status --short
```

As branches devem continuar as mesmas; o Contexto não deve ter acrescentado mudanças rastreadas. Alterações anteriores precisam continuar preservadas. Não foram necessários restart, build ou deploy para essa instalação.

## 19. Uso diário e novas conexões SSH

Em uma nova sessão Bash, carregue os caminhos:

```bash
source "$HOME/.config/contexto/vps.env.sh"
```

O agente passa `--project` com a raiz **atual** da worktree. Os valores `WT_BACK` e `WT_FRONT` do tutorial não foram salvos no arquivo de ambiente: não os reutilize por suposição em outra sessão. Use os caminhos registrados no estado da sua tarefa. Para listar as worktrees existentes:

```bash
git -C "$BACK" worktree list
git -C "$FRONT" worktree list
```

Não mova a instalação Node/Contexto depois do `setup` sem atualizar os hooks. Não copie SQLite de outra máquina para instalar: somente código/documentação e configuração saneada são portáveis. Em uma VPS nova ou em clones novos, repita o registro de cada repositório.

## 20. Como preservar o histórico antes de limpar a conferência

Você pode manter as worktrees de conferência enquanto estiver aprendendo. O tutorial não inclui remoção automática nem exclusão de branches.

Quando terminar, sem agentes/processos ativos nessas pastas, arquive cada uma:

```bash
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" archive --project "$WT_BACK"
"$CONTEXTO_NODE" "$CONTEXTO/contexto.mjs" archive --project "$WT_FRONT"
```

Se já estiver em outra sessão, recupere os caminhos reais em `worktree list` e defina as duas variáveis corretamente antes desses comandos. Não arquive uma pasta diferente só porque tem nome parecido.

Espere `archived: true`. `cleanup_safe: false` significa que existem itens desconhecidos a preservar. Mesmo com `true`, a remoção exige as verificações de ownership, Git limpo, commits preservados e ausência de executores do seu fluxo. Não use exclusão recursiva ou `--force` para contornar essas verificações. Os arquivos históricos permanecem nos metadados Git comuns e precisam fazer parte da política de backup se você quiser mantê-los após perder/remover o repositório.

## Problemas comuns

| Situação | O que verificar |
| --- | --- |
| `No such file or directory` | Confirme caminhos e maiúsculas/minúsculas; `pwd` e `ls` ajudam |
| `Permission denied` | Use o usuário autorizado para os repositórios; não aplique permissões globais indiscriminadas |
| `detected dubious ownership` | Confira proprietário/usuário com o administrador; não configure `safe.directory=*` |
| `node: command not found` | Use `CONTEXTO_NODE` absoluto e carregue o arquivo de ambiente da etapa 8 |
| `Cannot find module contexto.mjs` | Pode ter copiado para `contexto/contexto`; confira a estrutura da etapa 7 |
| Node antigo ou SQLite ausente | Use o runtime separado e repita o teste em memória |
| `Preparação automática não escreve em main/master` | Use uma worktree de tarefa; não troque o checkout de produção |
| Hook não criou `.contexto` | Leia `automatic_hook`; o agente executa `ensure` como fallback obrigatório |
| Estado pertence a outra worktree | Pare de usar a cópia e preserve o histórico; não transporte bancos/aprovações |
| `Preparação ocupada` | Confira o processo dono do lock; não apague lock só para prosseguir |
| Busca vazia | Confira o termo, a allowlist e se é necessário rodar `index` |
| Relatório não atualizado | Confira acesso a `.contexto/reports` e execute `report`; não repita um programa já capturado por causa de falha da projeção |
| MCP tenta usar caminho Linux no Windows | Reconfigure para execução remota ou use a CLI no terminal SSH |

## Conferência final

- [ ] Estou executando os comandos na VPS, com o usuário correto.
- [ ] Confirmei os nomes e caminhos reais dos dois repositórios.
- [ ] O teste em memória de Node/SQLite/FTS5 passou.
- [ ] Há uma instalação do programa `contexto` fora dos dois repositórios.
- [ ] `setup` terminou com `registered: true` em cada repositório.
- [ ] Entendi se o hook ficou automático ou se depende do criador/agente.
- [ ] `ensure` e `doctor` funcionaram nas duas worktrees de conferência.
- [ ] Cada raiz tem banco próprio e `.contexto` está ignorada pelo Git.
- [ ] As branches originais e alterações anteriores foram preservadas.
- [ ] Acrescentei a regra de preparação às instruções realmente carregadas pelo agente.
- [ ] Sei abrir o relatório e distinguir estimativa de tokens de contadores reais.

Este documento é um roteiro para executar no seu ambiente. A criação deste tutorial não representa uma conexão, instalação ou validação realizada na sua VPS.
