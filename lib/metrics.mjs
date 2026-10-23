import { atomicWrite, id, now, safePath } from './safety.mjs';

export function usage(store, input) {
  if (!input || typeof input !== 'object') throw Error('Medição inválida');
  const records = Array.isArray(input.records) ? input.records : [input];
  if (!records.length || records.length > 500) throw Error('Informe entre 1 e 500 medições');
  return store.transaction(() => {
    let inserted = 0, duplicates = 0;
    for (const item of records) {
      id(item.id); id(item.workload);
      if (!['baseline', 'current'].includes(item.arm)) throw Error('arm deve ser baseline ou current');
      if (typeof item.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]{0,99}$/.test(item.model)) throw Error('Modelo inválido');
      for (const key of ['input_tokens', 'output_tokens']) if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > 1000000000) throw Error(`Contagem inválida: ${key}`);
      const cached = item.cached_input_tokens ?? 0;
      if (!Number.isSafeInteger(cached) || cached < 0 || cached > item.input_tokens) throw Error('cached_input_tokens inválido');
      const record = { id: item.id, workload: item.workload, model: item.model, arm: item.arm, input_tokens: item.input_tokens, output_tokens: item.output_tokens, cached_input_tokens: cached };
      const body = JSON.stringify(record), previous = store.db.prepare('SELECT body FROM usage WHERE id=?').get(record.id);
      if (previous && previous.body !== body) throw Error('ID de medição reutilizado com dados diferentes');
      if (previous) { duplicates++; continue; }
      store.db.prepare('INSERT INTO usage VALUES(?,?,?)').run(record.id, body, now()); inserted++;
    }
    return { inserted, duplicates, measured_by: 'client-provided token counters; not independently verified' };
  });
}
export function summarize(store) {
  const rows = store.db.prepare(`SELECT kind,COUNT(*) AS calls,
    SUM(CASE WHEN json_extract(details,'$.complete')=1 THEN available ELSE 0 END) AS available,
    SUM(CASE WHEN json_extract(details,'$.complete')=1 THEN returned ELSE 0 END) AS returned,
    SUM(CASE WHEN json_extract(details,'$.complete')=1 THEN (available+3)/4 ELSE 0 END) AS tokens_before,
    SUM(CASE WHEN json_extract(details,'$.complete')=1 THEN (returned+3)/4 ELSE 0 END) AS tokens_after,
    SUM(CASE WHEN json_extract(details,'$.complete')=1 THEN 0 ELSE 1 END) AS incomplete
    FROM metrics GROUP BY kind ORDER BY kind`).all();
  const groups = new Map(), daily = new Map(); let excluded = 0;
  for (const row of rows) {
    const group = { operation: row.kind, calls: row.calls, available_bytes: row.available, returned_bytes: row.returned, estimated_tokens_before: row.tokens_before, estimated_tokens_after: row.tokens_after, incomplete_calls: row.incomplete };
    excluded += row.incomplete;
    groups.set(row.kind, group);
  }
  for (const row of store.db.prepare(`SELECT substr(at,1,10) AS date_utc,COUNT(*) AS calls,SUM(available) AS available_bytes,SUM(returned) AS returned_bytes FROM metrics WHERE json_extract(details,'$.complete')=1 GROUP BY substr(at,1,10) ORDER BY date_utc`).all()) daily.set(row.date_utc, { ...row });
  const operations = [...groups.values()].map(group => ({ ...group, bytes_avoided: group.available_bytes - group.returned_bytes, estimated_tokens_avoided: group.estimated_tokens_before - group.estimated_tokens_after, reduction_percent: group.available_bytes ? Math.round((1 - group.returned_bytes / group.available_bytes) * 10000) / 100 : null }));
  const measurements = store.db.prepare('SELECT body FROM usage ORDER BY rowid').all().map(row => JSON.parse(row.body));
  const cohorts = new Map();
  for (const item of measurements) {
    const key = `${item.workload}|${item.model}`, cohort = cohorts.get(key) || { workload: item.workload, model: item.model, baseline: null, current: null };
    const arm = cohort[item.arm] || { records: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };
    arm.records++; arm.input_tokens += item.input_tokens; arm.output_tokens += item.output_tokens; arm.cached_input_tokens += item.cached_input_tokens;
    cohort[item.arm] = arm; cohorts.set(key, cohort);
  }
  const comparisons = [...cohorts.values()].map(cohort => {
    if (!cohort.baseline || !cohort.current) return { ...cohort, comparable: false, reason: 'Falta baseline ou current para o mesmo workload/modelo' };
    const before = cohort.baseline.input_tokens + cohort.baseline.output_tokens, after = cohort.current.input_tokens + cohort.current.output_tokens;
    return { ...cohort, comparable: true, comparability: 'Mesmo rótulo/modelo; equivalência de trabalho deve ser conferida pelo operador', observed_token_difference: before - after, reduction_percent: before ? Math.round((1 - after / before) * 10000) / 100 : null };
  });
  const suggestions = [];
  if (!rows.length) suggestions.push('Execute pack/capture no trabalho real para formar uma amostra; ainda não há redução local observada.');
  for (const group of operations) {
    if (group.calls < 5) suggestions.push(`${group.operation}: só ${group.calls} amostra(s); reúna mais execuções antes de mudar o padrão.`);
    if (group.bytes_avoided < 0) suggestions.push(`${group.operation}: metadados devolveram ${-group.bytes_avoided} bytes a mais que a referência; use saída direta em operações pequenas.`);
    else if (group.reduction_percent !== null && group.reduction_percent < 20) suggestions.push(`${group.operation}: redução local de ${group.reduction_percent}%; revise orçamento/seleção de conteúdo para essa operação.`);
    if (group.incomplete_calls) suggestions.push(`${group.operation}: ${group.incomplete_calls} execução(ões) sem prova de completude; confira registros legados, timeout ou limite antes de comparar economia.`);
  }
  if (!comparisons.some(item => item.comparable)) suggestions.push('Importe contadores reais de baseline e current do mesmo trabalho/modelo; estimativa local não prova economia total de tokens.');
  for (const item of comparisons) if (item.comparable && item.observed_token_difference < 0) suggestions.push(`${item.workload}: consumo informado aumentou em ${-item.observed_token_difference} tokens; examine consultas extras e retrabalho.`);
  return { schema: 1, project: store.config.id, generated_at_utc: now(), estimate_method: 'ceil(bytes UTF-8 / 4), heurística sem tokenizer de modelo', scope: 'Somente saídas pack/capture; envelope de transporte, entrada histórica, raciocínio e demais ferramentas não contabilizados automaticamente', incomplete_calls_excluded_from_savings: excluded, operations, daily: [...daily.values()], client_measurements: measurements.length, comparisons, suggestions: suggestions.slice(0, 8) };
}
export function writeReport(store) {
  const result = summarize(store);
  const lines = ['# Eficiência do Contexto', '', `Projeto: ${result.project}. Atualizado em UTC: ${result.generated_at_utc}.`, '', '## Como ler', '', 'Bytes são contados nas saídas locais. Tokens estimados = ceil(bytes UTF-8 / 4), sem tokenizer de modelo; não são tokens faturados. Capturas incompletas não entram na redução. Valores negativos representam aumento de saída.', '', result.scope, '', '## Saídas locais observadas', '', '| Operação | Chamadas | Bytes referência | Bytes devolvidos | Bytes evitados | Tokens estimados evitados | Redução local | Incompletas |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const item of result.operations) lines.push(`| ${item.operation} | ${item.calls} | ${item.available_bytes} | ${item.returned_bytes} | ${item.bytes_avoided} | ${item.estimated_tokens_avoided} | ${item.reduction_percent ?? 'n/a'}% | ${item.incomplete_calls} |`);
  lines.push('', 'Referência de capture: bytes observados do processo. Referência de pack: candidatos de trechos antes do orçamento. Não some isso como economia da sessão inteira.', '', '## Histórico diário (UTC)', '', '| Data | Chamadas completas | Bytes referência | Bytes devolvidos |', '| --- | ---: | ---: | ---: |');
  for (const item of result.daily) lines.push(`| ${item.date_utc} | ${item.calls} | ${item.available_bytes} | ${item.returned_bytes} |`);
  lines.push('', '## Contadores reais informados pelo cliente', '', 'Esses valores são importados, não inferidos. Compare baseline/current apenas quando representam o mesmo trabalho e modelo. Cached input é parte de input, não deve ser somado de novo. Não há estimativa de preço.', '', '| Trabalho | Modelo | Tokens baseline (entrada + saída) | Tokens current | Diferença observada | Redução |', '| --- | --- | ---: | ---: | ---: | ---: |');
  for (const item of result.comparisons) lines.push(`| ${item.workload} | ${item.model} | ${item.baseline ? item.baseline.input_tokens + item.baseline.output_tokens : 'ausente'} | ${item.current ? item.current.input_tokens + item.current.output_tokens : 'ausente'} | ${item.observed_token_difference ?? 'não comparável'} | ${item.reduction_percent ?? 'n/a'}% |`);
  lines.push('', '## Sugestões automáticas', '', 'Regras locais baseadas nos números acima; sem chamada a modelo, sem alteração automática de configuração.', '', ...result.suggestions.map(item => `- ${item}`), '', 'Arquivo gerado; anotações pessoais devem ficar em outro arquivo. JSON com os mesmos dados: efficiency.json.', '');
  atomicWrite(safePath(store.root, '.contexto/reports/efficiency.md', { existing: false }), lines.join('\n'));
  atomicWrite(safePath(store.root, '.contexto/reports/efficiency.json', { existing: false }), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function refreshReport(store) {
  // Projeção derivada não pode ocultar o resultado de uma operação já confirmada.
  try { writeReport(store); }
  catch { process.stderr.write(JSON.stringify({ warning: 'Relatório de eficiência não atualizado; operação e métrica preservadas. Confira .contexto/reports e execute report.' }) + '\n'); }
}
