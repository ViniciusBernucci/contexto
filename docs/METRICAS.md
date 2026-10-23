# Medir eficiência

O relatório fica em `.contexto/reports/efficiency.md` dentro de **cada raiz/worktree**. O arquivo irmão `efficiency.json` permite comparar resultados com scripts. Ambos são gerados depois de `pack`, `capture` e `usage`; `report`/`stats` reconstroem a projeção a qualquer momento. Não escreva notas pessoais nesses arquivos, pois serão sobrescritas.

Se a projeção automática não puder ser escrita, a operação confirmada preserva seu resultado e devolve um aviso em stderr. Resolva o acesso a `.contexto/reports` e rode `report`; esse comando explícito informa falha se o relatório continuar indisponível. Não repita um programa capturado apenas porque a projeção ficou desatualizada.

## Duas medições diferentes

| Medida | Origem | O que conclui |
| --- | --- | --- |
| Bytes locais | Contagem UTF-8 de candidatos/saída | Quanto conteúdo a operação devolveu versus sua referência |
| Tokens estimados | `ceil(bytes / 4)` por chamada, antes e depois | Aproximação reproduzível, sem tokenizer; não prova faturamento |
| Contadores de tokens importados | Dados de uso informados pelo cliente | Diferença observada entre grupos que você declarou equivalentes |

Para `pack`, a referência são os trechos candidatos selecionados antes de aplicar o orçamento; a resposta inclui metadados/estrutura. Não representa o repositório inteiro. Para `capture`, a referência são os bytes de stdout/stderr observados; a resposta é o diagnóstico JSON. A redução de bytes é `referência - devolvido`; percentual é `100 × (1 - devolvido/referência)`. Referência zero produz percentual indefinido. Um resultado negativo significa aumento. Saídas de diferentes operações podem se sobrepor: não some isso como economia da sessão.

Captura com timeout ou limite excedido não prova que o processo terminou nem conhece toda a saída; fica fora da redução. Métricas legadas sem indicador de completude também ficam fora. Captura completa de um processo que falhou pode medir redução de saída, sem transformar a falha em sucesso.

Estimativas não incluem histórico da conversa, raciocínio, envelopes MCP, outras ferramentas, consultas extras ou os tokens para ler o próprio relatório. O Contexto não consegue observar automaticamente o uso total do cliente. `search`/`read` não são tratados como conteúdo evitado; ler mais detalhes pode reduzir a economia do fluxo.

## Comparação prática com contadores reais

1. Escolha trabalhos equivalentes e critérios de qualidade iguais. Fixe modelo e condições relevantes do cliente. Não use uma tarefa simples como baseline de uma tarefa mais complexa.
2. Execute o grupo **baseline**, sem as otimizações que quer avaliar. Guarde tokens de entrada/saída reportados pelo cliente e o resultado de qualidade/retrabalho.
3. Execute o grupo **current** com Contexto. Use a mesma quantidade de trabalho; some todas as sessões/agentes envolvidos em cada grupo, incluindo correções e leitura de relatórios.
4. Crie `usage.json` com contadores reais. Use IDs únicos por registro; não coloque prompts, respostas, chaves, nomes de pessoas ou outros dados privados nesse arquivo.
5. Importe e leia a comparação. Repita com mais trabalhos antes de mudar padrões do fluxo.

Exemplo **inteiramente fictício**, para entender o formato:

```json
{
  "records": [
    { "id": "baseline-001", "workload": "sample-task", "model": "sample-model", "arm": "baseline", "input_tokens": 12000, "output_tokens": 1000, "cached_input_tokens": 6000 },
    { "id": "current-001", "workload": "sample-task", "model": "sample-model", "arm": "current", "input_tokens": 7000, "output_tokens": 900, "cached_input_tokens": 3000 }
  ]
}
```

```powershell
node contexto.mjs usage --project ../sample-app --file usage.json
node contexto.mjs report --project ../sample-app
```

O exemplo resulta em 13.000 versus 7.900 tokens, diferença de 5.100 (39,23%). Esse número é didático, sem relação com uma execução real. `cached_input_tokens` já está dentro de `input_tokens`; não é somado novamente. Não há cálculo de preço, pois tarifas/cache variam. O programa valida números e agrupa pelo mesmo `workload` e `model`; **equivalência do trabalho continua sendo responsabilidade do operador**. Ele soma os registros de cada grupo, sem corrigir diferenças na quantidade de trabalho. Modelos diferentes e grupos incompletos não geram uma comparação.

IDs repetidos com o mesmo conteúdo são idempotentes; conteúdo diferente para o mesmo ID rejeita a transação inteira. Campos desconhecidos não são persistidos. Preserve o arquivo original de contadores se quiser conferência independente; o Contexto não autentica dados contra o fornecedor. O importador aceita até 500 registros por chamada.

## Sugestões automáticas

Regras determinísticas produzem até oito sugestões breves no relatório: amostra pequena, overhead maior que a referência, baixa redução local, captura incompleta, falta de comparação real e aumento de tokens informados. Elas não chamam modelos, não alteram configuração nem diminuem gates de qualidade. São pistas para investigar.

Exemplo de evolução: se `pack` economiza pouco e você precisa de várias consultas extras, reveja seleção/orçamento e compare novamente o total dos agentes. Se uma captura retorna mais bytes que o programa, evite resumir comandos muito pequenos. Registre a decisão e a versão avaliada fora do relatório gerado.

## Worktrees e retenção

Cada worktree tem métricas isoladas. Não há consolidador automático de todos os bancos nesta versão. Para avaliar um lote com várias worktrees, some os contadores do cliente em um workload de comparação numa raiz de relatório escolhida; não importe os mesmos registros duas vezes com IDs diferentes. `archive` preserva métricas no SQLite histórico antes da remoção; Markdown/JSON podem ser regenerados a partir do estado correspondente. Não copie esse histórico para reutilizar aprovações.
