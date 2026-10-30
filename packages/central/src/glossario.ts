/**
 * Conhecimento de negócio sobre o banco da Central, tirado do código do tutts-backend
 * (chat IA do BI, alerta de disponibilidade, módulo financeiro). É o que impede a IA
 * de somar valores duplicados ou contar coleta como entrega.
 */

/** Descrições curtas das tabelas mais usadas (as demais aparecem só com o módulo). */
export const DESCRICAO_TABELA: Record<string, string> = {
  bi_entregas: "uma linha por ponto de cada OS (ponto 1 = coleta, 2+ = entrega): cliente, motoboy, datas, prazo/SLA, valores",
  bi_resumo_diario: "resumo pré-calculado por dia",
  bi_resumo_cliente: "resumo pré-calculado por cliente",
  bi_resumo_profissional: "resumo pré-calculado por motoboy",
  bi_prazos_cliente: "prazo de entrega configurado por cliente",
  bi_regioes: "regiões do BI",
  disponibilidade_regioes: "regiões da escala de disponibilidade (com gestores)",
  disponibilidade_lojas: "lojas atendidas, por região, com quantidade de vagas titulares",
  disponibilidade_linhas: "a escala de HOJE: uma linha por vaga/motoboy em cada loja, com status",
  disponibilidade_faltosos: "faltas registradas (data e motivo)",
  disponibilidade_sem_contato: "motoboys sem contato, com dias consecutivos",
  disponibilidade_em_loja: "registro de motoboys que chegaram na loja",
  disponibilidade_espelho: "foto diária da escala (histórico em JSON)",
  disponibilidade_observacoes_historico: "observações da escala por dia",
  withdrawal_requests: "pedidos de saque dos motoboys: valor pedido, taxa, valor final, status",
  gratuities: "gratuidades (saques sem taxa) concedidas aos motoboys",
  withdrawal_taxa_fixa: "taxas fixas de saque",
  filas_posicoes: "posição dos motoboys nas filas de despacho",
  filas_historico: "histórico das filas",
  filas_centrais: "centrais de fila",
  score_totais: "pontuação total de cada motoboy no Score",
  score_ranking_mensal: "ranking mensal do Score",
  score_historico: "lançamentos de pontos do Score",
  cs_clientes: "clientes acompanhados pelo Customer Success (health score)",
  cs_ocorrencias: "ocorrências abertas por cliente no CS",
  cs_interacoes: "interações do CS com clientes",
  solicitacoes_corrida: "corridas pedidas pelos clientes no portal de solicitação",
  crm_leads_capturados: "leads de prospecção",
  comissao_lancamentos: "comissões de vendedores",
  sinistros: "sinistros (acidentes/avarias) com valores",
  garantido_registros: "valor mínimo garantido pago aos motoboys",
  diaria_registros: "diárias pagas aos motoboys",
  performance_snapshots: "fotos periódicas de performance",
  todo_tarefas: "tarefas internas",
  motos: "frota de motos para locação",
  moto_contratos: "contratos de locação de motos",
  moto_parcelas: "parcelas da locação de motos",
};

export const REGRAS_NEGOCIO = `
CONTEXTO: Central Tutts, entregas rápidas de autopeças com motoboys (Salvador/BA e outras praças). Fuso: America/Bahia.
Datas relativas ("hoje", "ontem", "essa semana", "este mês") são em America/Bahia: use (now() AT TIME ZONE 'America/Bahia')::date.

ENTREGAS (bi_entregas):
- Cada OS tem vários pontos. ponto 1 = coleta; ponto >= 2 = entrega. Para contar ENTREGAS: WHERE COALESCE(ponto, 1) >= 2.
- Período: filtre por data_solicitado (DATE).
- O BI da Central SÓ CONTA OS CONCLUÍDAS: sempre inclua COALESCE(os_concluida, finalizado IS NOT NULL) no WHERE (OS em andamento não entram nem como no prazo).
- Clientes: use nome_fantasia (e cod_cliente). Motoboys: nome_prof (e cod_prof). centro_custo = filial/loja do cliente.
- SLA (taxa de prazo): ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 2).
- Fora do prazo: COUNT(*) FILTER (WHERE dentro_prazo = false).
- Prazo da LOJA (dentro_prazo, tempo_execucao_minutos): da criação do pedido (data_hora) até a finalização. Prazo do PROFISSIONAL (dentro_prazo_prof, tempo_entrega_prof_minutos): da coleta (saída do ponto 1) até a finalização — o motoboy não é cobrado pelo deslocamento até a loja.
- Regra das 17h (vale para os dois prazos e para alocação/coleta): começou às 17h ou depois e terminou em outro dia → conta a partir das 08:00 do dia em que terminou. As consultas prontas "entregas", "tempos" e "profissionais" já aplicam isso.
- Tempo médio: ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos >= 0), 1).
- Retornos (como o dashboard conta): ocorrencia contendo 'cliente fechado', 'clienteaus', 'cliente ausente', 'loja fechada' ou 'produto incorreto' (LOWER + LIKE). Conte por OS: COUNT(DISTINCT os).
- Entregas x OS: COUNT(*) = entregas; COUNT(DISTINCT os) = OS.
- TICKET MÉDIO do BI (o da tela): (SUM(valor) − SUM(valor_prof)) / COUNT(entregas), somando TODAS as linhas de entrega (ponto >= 2) SEM DISTINCT por OS, só OS concluídas. Ticket bruto = SUM(valor) / COUNT(entregas). Semana = semana ISO (EXTRACT(WEEK), segunda a domingo). Prefira a ação "central" (bi.comparativo_semanal_clientes ou bi.dashboard): é exatamente esse cálculo.
- Meta geral de SLA: 85%. Cliente 767 (Grupo Comollati): prazo fixo de 120 min, SLA por tempo_execucao_minutos <= 120, meta 95%.
- Clientes 949, 1165, 1151, 1178, 1188, 35, 794, 249, 1206, 1222: consolidar todos os centros de custo numa linha.
- Nomes parciais: use ILIKE '%parte%' (ex.: "goiânia" → centro_custo ILIKE '%goi%nia%').

FATURAMENTO (bi_entregas):
- NUNCA some valor direto: há uma linha por ponto e os valores se repetem. Use:
  WITH fat AS (SELECT DISTINCT ON (os) os, valor, valor_prof FROM bi_entregas WHERE COALESCE(os_concluida, finalizado IS NOT NULL) AND COALESCE(ponto,1) >= 2 AND <filtros> ORDER BY os, ponto ASC)
  SELECT SUM(valor) AS cobrado, SUM(valor_prof) AS pago_motoboys, SUM(valor) - SUM(valor_prof) AS faturamento FROM fat
- Faturamento (margem) = valor (cliente) - valor_prof (profissional).
- Para o número EXATO da tela do BI Financeiro (com garantido, taxas e projeção), prefira a ação "central" com fin.painel.

DISPONIBILIDADE (escala do dia):
- disponibilidade_linhas é a escala ATUAL (zera a cada dia). Liga em disponibilidade_lojas (loja_id) → disponibilidade_regioes (regiao_id).
- Vaga titular: is_excedente = false e is_reposicao = false. Excedente e reposição são extras.
- Status (UPPER(TRIM(status))): 'EM LOJA' (chegou), 'CONFIRMADO', 'FALTANDO', 'SEM CONTATO', 'A CONFIRMAR'. Linha sem cod_profissional = vaga aberta.
- % em loja = em loja / titulares.

SAQUES (withdrawal_requests):
- status: 'aguardando_aprovacao', 'pendente', 'aprovado', 'processando', 'aguardando_pagamento_stark', 'pago', 'rejeitado'.
- requested_amount = pedido; fee_amount = taxa; final_amount = valor pago. Datas: created_at (pedido), approved_at.
- user_cod / user_name identificam o motoboy.

REGRAS SQL:
- Só SELECT (ou WITH ... SELECT). Use apenas as tabelas listadas (schema argos, sem prefixo).
- Sempre agregue ou limite: no máximo 200 linhas no resultado.
- Divisões com NULLIF(x, 0). Valores em reais com 2 casas.
- Prefira colunas com nomes claros no resultado (AS entregas, AS sla_pct, AS faturamento).
`;
