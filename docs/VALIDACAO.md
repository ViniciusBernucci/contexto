# Validação da versão 0.2.0

Snapshot da distribuição local, sem commit Git de release. Hashes relativos estão em `source-manifest.json`; não há caminhos da máquina de origem neste documento. Executado em 2026-10-23 com Node22.20.0, SQLite3.50.4/FTS5, Git for Windows e Bash.

- Suíte completa: **45 testes PASS**, zero falhas, zero skips, com `node --test tests/*.test.mjs`.
- Revisão independente de worktrees e métricas: achados corrigidos, auditados e revalidados. Inclui estado rastreado com caixa diferente, hooksPath vazio e falha da projeção após comando já executado.
- QA independente: **13 cenários funcionais PASS**, incluindo instalação limpa, hook anterior com falha, herança/isolamento, fallback sem hook, contadores baseline/current, cache, timeout, MCP e arquivo histórico.
- Distribuição instalada: lista explícita de documentos públicos; recibos internos do gerador não são copiados. Dados operacionais e configurações dos clientes não são transportados.
- Diagramas Archify: `validate`, `deliver`, `check` e `browser-check` PASS para arquitetura e fluxo. A validação de navegador mede vários viewports e temas; não foi feita revisão perceptual. Conteúdo em português; controles do viewer usam fallback em inglês.

Os recibos brutos de geração/review ficam fora da distribuição porque contêm caminhos do ambiente de execução. Removê-los do pacote não altera os HTML; seus hashes permanecem no manifesto. Este snapshot comprova as verificações descritas, sem afirmar garantia de segurança absoluta ou economia real de tokens em todos os projetos. Reexecute os testes ao modificar o programa. Os testes usam dados fictícios e seus contadores não constituem baseline de produção.
