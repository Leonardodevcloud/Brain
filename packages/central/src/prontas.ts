import { consultar, type PoolLeitura, type ResultadoConsulta } from "./leitura.js";

// Comparação de nomes sem acento e sem caixa ("maceio" encontra "Maceió"), sem depender da extensão unaccent.
const COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüç";
const SEM_ACENTO = "aaaaaeeeeiiiiooooouuuuc";
const semAcento = (v: string) => v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** Uma resposta pronta: SQL escrito e testado à mão para as perguntas de todo dia. */
export interface ConsultaPronta {
  nome: string;
  descricao: string;
  /** Parâmetros que a IA pode preencher. */
  parametros: Record<string, string>;
  executar(pool: PoolLeitura, p: Record<string, unknown>): Promise<ResultadoPronto>;
}

export interface ResultadoPronto extends ResultadoConsulta {
  titulo: string;
  sql: string;
  /** Números principais, já calculados, para a fala e os destaques. */
  totais: Record<string, number | string | null>;
}

const HOJE = `(now() AT TIME ZONE 'America/Bahia')::date`;
const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const data = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

async function rodar(pool: PoolLeitura, titulo: string, sql: string, params: unknown[], totais: (r: ResultadoConsulta) => ResultadoPronto["totais"]) {
  const r = await consultar(pool, sql, params, { limite: 200 });
  return { ...r, titulo, sql: sql.trim(), totais: totais(r) };
}

const soma = (linhas: Record<string, unknown>[], col: string) => linhas.reduce((s, l) => s + Number(l[col] ?? 0), 0);
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// ── Regras do BI da Central (portadas do tutts-backend: os-concluida.js e shared/prazo-regra.js) ──

/** BI só conta corrida concluída: todos os pontos da OS finalizados (coluna os_concluida; sem ela, a linha finalizada). */
export const FILTRO_CONCLUIDA = "COALESCE(os_concluida, finalizado IS NOT NULL)";

/**
 * Minutos entre dois momentos com a regra das 17h: começou às 17h ou depois e terminou em outro dia →
 * conta a partir das 08:00 do dia em que terminou (antes das 08:00 = 0). Senão, tempo corrido. Invertido = NULL.
 */
export function regra17h(inicio: string, fim: string) {
  return `(CASE WHEN ${fim} IS NOT NULL AND ${inicio} IS NOT NULL THEN
    CASE WHEN DATE(${fim}) > DATE(${inicio}) AND EXTRACT(HOUR FROM ${inicio}) >= 17
         THEN GREATEST(0, EXTRACT(EPOCH FROM (${fim} - (DATE(${fim}) + TIME '08:00:00'))) / 60.0)
         WHEN ${fim} >= ${inicio} THEN EXTRACT(EPOCH FROM (${fim} - ${inicio})) / 60.0
         ELSE NULL END
  ELSE NULL END)`;
}

/** Prazo da loja (cliente): criação do pedido → finalização. */
const TEMPO_LOJA = regra17h("data_hora", "finalizado");

/** Retorno, como o dashboard conta (isRetorno do dashboard-completo). */
export const RETORNO = `(LOWER(COALESCE(ocorrencia, '')) LIKE ANY (ARRAY['%cliente fechado%','%clienteaus%','%cliente ausente%','%loja fechada%','%produto incorreto%']))`;

/** Filtro padrão das consultas do BI: período (padrão hoje), cliente por nome ou código, só OS concluídas. */
function filtroBi(p: Record<string, unknown>, params: unknown[]) {
  const inicio = data(p.inicio);
  const fim = data(p.fim) ?? inicio;
  const partes = [FILTRO_CONCLUIDA];
  partes.push(inicio ? `data_solicitado BETWEEN $${params.push(inicio)} AND $${params.push(fim)}` : `data_solicitado = ${HOJE}`);
  const cliente = texto(p.cliente);
  if (cliente) partes.push(`translate(lower(nome_fantasia), '${COM_ACENTO}', '${SEM_ACENTO}') LIKE '%' || $${params.push(semAcento(cliente))} || '%'`);
  const cod = Number(p.cod_cliente);
  if (Number.isInteger(cod) && cod > 0) partes.push(`cod_cliente = $${params.push(cod)}`);
  return { onde: partes.join(" AND "), inicio, fim };
}

const tituloPeriodo = (o: string, inicio: string | null, fim: string | null) =>
  inicio ? `${o} de ${inicio}${fim && fim !== inicio ? ` a ${fim}` : ""}` : `${o} de hoje`;

export const CONSULTAS_PRONTAS: ConsultaPronta[] = [
  {
    nome: "disponibilidade",
    descricao: "Como está a escala/disponibilidade de motoboys AGORA: por região (ou loja), titulares, em loja, confirmados, faltando, sem contato, a confirmar, vagas abertas.",
    parametros: { regiao: "nome (ou parte) da região, opcional", por: "'regiao' (padrão) ou 'loja'", ordenar: "'faltas' para as lojas com mais faltas primeiro (opcional)" },
    async executar(pool, p) {
      const porLoja = p.por === "loja";
      const porFaltas = p.ordenar === "faltas";
      const regiao = texto(p.regiao) ? semAcento(texto(p.regiao) as string) : undefined;
      const sql = `
        WITH vagas AS (
          SELECT r.nome AS regiao, l.nome AS loja,
                 UPPER(TRIM(li.status)) AS status,
                 NULLIF(TRIM(li.cod_profissional), '') IS NOT NULL AS preenchida
            FROM disponibilidade_linhas li
            JOIN disponibilidade_lojas l ON l.id = li.loja_id
            LEFT JOIN disponibilidade_regioes r ON r.id = l.regiao_id
           WHERE COALESCE(li.is_excedente, false) = false AND COALESCE(li.is_reposicao, false) = false
             ${regiao ? `AND translate(lower(r.nome), '${COM_ACENTO}', '${SEM_ACENTO}') LIKE '%' || $1 || '%'` : ""}
        )
        SELECT ${porLoja ? "regiao, loja" : "COALESCE(regiao, 'Sem região') AS regiao"},
               COUNT(*) AS titulares,
               COUNT(*) FILTER (WHERE preenchida AND status = 'EM LOJA') AS em_loja,
               COUNT(*) FILTER (WHERE preenchida AND status = 'CONFIRMADO') AS confirmados,
               COUNT(*) FILTER (WHERE preenchida AND status = 'FALTANDO') AS faltando,
               COUNT(*) FILTER (WHERE preenchida AND status = 'SEM CONTATO') AS sem_contato,
               COUNT(*) FILTER (WHERE preenchida AND status = 'A CONFIRMAR') AS a_confirmar,
               COUNT(*) FILTER (WHERE NOT preenchida) AS vagas_abertas,
               ROUND(100.0 * COUNT(*) FILTER (WHERE preenchida AND status = 'EM LOJA') / NULLIF(COUNT(*), 0), 1) AS pct_em_loja
          FROM vagas
         GROUP BY ${porLoja ? "regiao, loja" : "1"}
         ORDER BY ${porFaltas ? "COUNT(*) FILTER (WHERE preenchida AND status IN ('FALTANDO', 'SEM CONTATO')) DESC, COUNT(*) FILTER (WHERE preenchida AND status = 'FALTANDO') DESC, pct_em_loja ASC NULLS FIRST" : "pct_em_loja ASC NULLS FIRST, titulares DESC"}`;
      return rodar(pool, porFaltas ? "Lojas com mais faltas agora" : porLoja ? "Disponibilidade por loja agora" : "Disponibilidade por região agora", sql, regiao ? [regiao] : [], (r) => {
        const titulares = soma(r.linhas, "titulares");
        const emLoja = soma(r.linhas, "em_loja");
        return {
          titulares,
          em_loja: emLoja,
          pct_em_loja: pct(emLoja, titulares),
          confirmados: soma(r.linhas, "confirmados"),
          faltando: soma(r.linhas, "faltando"),
          sem_contato: soma(r.linhas, "sem_contato"),
          a_confirmar: soma(r.linhas, "a_confirmar"),
          vagas_abertas: soma(r.linhas, "vagas_abertas"),
        };
      });
    },
  },
  {
    nome: "entregas",
    descricao:
      "Entregas e SLA do cliente num período (padrão: hoje), por cliente, com as regras do BI da Central: só OS concluídas, prazo da loja (criação → finalização, regra das 17h), retornos como no dashboard.",
    parametros: { inicio: "AAAA-MM-DD (padrão hoje)", fim: "AAAA-MM-DD (padrão = inicio)", cliente: "nome (ou parte) do cliente, opcional", cod_cliente: "código do cliente, opcional" },
    async executar(pool, p) {
      const params: unknown[] = [];
      const { onde, inicio, fim } = filtroBi(p, params);
      const sql = `
        SELECT cod_cliente, nome_fantasia AS cliente,
               COUNT(*) AS entregas,
               COUNT(DISTINCT os) AS os,
               COUNT(*) FILTER (WHERE dentro_prazo = true) AS no_prazo,
               COUNT(*) FILTER (WHERE dentro_prazo = false) AS fora_prazo,
               ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS sla_pct,
               ROUND(AVG(${TEMPO_LOJA}), 1) AS tempo_medio_min,
               COUNT(DISTINCT os) FILTER (WHERE ${RETORNO}) AS os_com_retorno
          FROM bi_entregas
         WHERE ${onde} AND COALESCE(ponto, 1) >= 2
         GROUP BY cod_cliente, nome_fantasia
         ORDER BY entregas DESC`;
      return rodar(pool, tituloPeriodo("Entregas", inicio, fim), sql, params, (r) => {
        const entregas = soma(r.linhas, "entregas");
        const no = soma(r.linhas, "no_prazo");
        const fora = soma(r.linhas, "fora_prazo");
        return { entregas, os: soma(r.linhas, "os"), no_prazo: no, fora_prazo: fora, sla_pct: pct(no, no + fora), clientes: r.linhas.length, os_com_retorno: soma(r.linhas, "os_com_retorno") };
      });
    },
  },
  {
    nome: "tempos",
    descricao:
      "Tempos médios do BI num período (padrão: hoje), por cliente ou por dia: alocação (pedido → motoboy alocado), coleta (alocado → chegada na loja) e entrega (pedido → finalização), todos com a regra das 17h da Central.",
    parametros: { inicio: "AAAA-MM-DD (padrão hoje)", fim: "AAAA-MM-DD (padrão = inicio)", cliente: "nome (ou parte), opcional", cod_cliente: "código, opcional", por: "cliente | dia (padrão cliente)" },
    async executar(pool, p) {
      const params: unknown[] = [];
      const { onde, inicio, fim } = filtroBi(p, params);
      const porDia = p.por === "dia";
      const chave = porDia ? "data_solicitado AS dia" : "nome_fantasia AS cliente";
      const grupo = porDia ? "data_solicitado" : "nome_fantasia";
      const sql = `
        SELECT ${chave},
               COUNT(DISTINCT os) AS os,
               ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN ${regra17h("data_hora", "data_hora_alocado")} END), 1) AS alocacao_min,
               ROUND(AVG(CASE WHEN COALESCE(ponto, 1) = 1 THEN ${regra17h("data_hora_alocado", "(data_chegada + hora_chegada::time)")} END), 1) AS coleta_min,
               ROUND(AVG(CASE WHEN COALESCE(ponto, 1) >= 2 THEN ${TEMPO_LOJA} END), 1) AS entrega_min
          FROM bi_entregas
         WHERE ${onde}
         GROUP BY ${grupo}
         ORDER BY ${porDia ? "dia" : "os DESC"}`;
      return rodar(pool, tituloPeriodo("Tempos médios", inicio, fim), sql, params, (r) => {
        const os = soma(r.linhas, "os");
        const media = (col: string) =>
          os ? Math.round((r.linhas.reduce((s, l) => s + Number(l[col] ?? 0) * Number(l.os ?? 0), 0) / os) * 10) / 10 : null;
        return { os, alocacao_min: media("alocacao_min"), coleta_min: media("coleta_min"), entrega_min: media("entrega_min") };
      });
    },
  },
  {
    nome: "profissionais",
    descricao:
      "Ranking dos motoboys num período (padrão: hoje), com o prazo do PROFISSIONAL da Central (da coleta na loja até a finalização; ele não é cobrado pelo deslocamento até a loja): entregas, % no prazo dele, tempo médio, retornos, valor recebido.",
    parametros: { inicio: "AAAA-MM-DD (padrão hoje)", fim: "AAAA-MM-DD (padrão = inicio)", cliente: "nome (ou parte), opcional", cod_cliente: "código, opcional", ordem: "entregas | prazo | piores (padrão entregas)" },
    async executar(pool, p) {
      const params: unknown[] = [];
      const { onde, inicio, fim } = filtroBi(p, params);
      const ordem =
        p.ordem === "piores" ? "prazo_prof_pct ASC NULLS LAST, entregas DESC" : p.ordem === "prazo" ? "prazo_prof_pct DESC NULLS LAST, entregas DESC" : "entregas DESC";
      const sql = `
        SELECT cod_prof, nome_prof AS profissional,
               COUNT(*) AS entregas,
               COUNT(DISTINCT os) AS os,
               COUNT(*) FILTER (WHERE dentro_prazo_prof = true) AS no_prazo_prof,
               COUNT(*) FILTER (WHERE dentro_prazo_prof = false) AS fora_prazo_prof,
               ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo_prof = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo_prof IS NOT NULL), 0), 1) AS prazo_prof_pct,
               ROUND(AVG(tempo_entrega_prof_minutos) FILTER (WHERE tempo_entrega_prof_minutos >= 0), 1) AS tempo_prof_min,
               COUNT(DISTINCT os) FILTER (WHERE ${RETORNO}) AS os_com_retorno,
               ROUND(SUM(valor_prof)::numeric, 2) AS valor_prof
          FROM bi_entregas
         WHERE ${onde} AND COALESCE(ponto, 1) >= 2 AND cod_prof IS NOT NULL
         GROUP BY cod_prof, nome_prof
         HAVING COUNT(*) > 0
         ORDER BY ${ordem}`;
      return rodar(pool, tituloPeriodo("Motoboys", inicio, fim), sql, params, (r) => {
        const no = soma(r.linhas, "no_prazo_prof");
        const fora = soma(r.linhas, "fora_prazo_prof");
        return { motoboys: r.linhas.length, entregas: soma(r.linhas, "entregas"), prazo_prof_pct: pct(no, no + fora), fora_prazo_prof: fora };
      });
    },
  },
  {
    nome: "margem_por_motoboy",
    descricao:
      "Margem por motoboy no dia, para clientes que pagam um valor FIXO por motoboy (ex.: POL-002, cliente 767 em BR Auto Parts Brasília e Comollati Brasília): lucro de cada motoboy = receita_dia − custo_dia − o que ele produziu (valor_prof, uma vez por OS). Cada motoboy conta UMA vez por dia, com quantas OS fizer. Devolve uma linha por motoboy e dia e o total.",
    parametros: {
      cod_cliente: "código do cliente (obrigatório)",
      centros: "lista de trechos do centro de custo, ex.: [\"br auto brasilia\", \"comollati brasilia\"] (todas as palavras de um trecho precisam aparecer)",
      receita_dia: "quanto a loja paga por motoboy no dia (R$)",
      custo_dia: "custo da moto por motoboy no dia (R$)",
      inicio: "AAAA-MM-DD (padrão hoje)",
      fim: "AAAA-MM-DD (padrão = inicio)",
    },
    async executar(pool, p) {
      const cod = Number(p.cod_cliente);
      const receita = Number(p.receita_dia);
      const custo = Number(p.custo_dia ?? 0);
      if (!Number.isInteger(cod) || cod <= 0) throw new Error("Informe cod_cliente.");
      if (!(receita > 0) || !(custo >= 0)) throw new Error("Informe receita_dia (> 0) e custo_dia (>= 0) em reais.");
      const params: unknown[] = [];
      const inicio = data(p.inicio);
      const fim = data(p.fim) ?? inicio;
      const periodo = inicio ? `data_solicitado BETWEEN $${params.push(inicio)} AND $${params.push(fim)}` : `data_solicitado = ${HOJE}`;
      const centros = (Array.isArray(p.centros) ? p.centros : typeof p.centros === "string" ? p.centros.split(/[,;]/) : [])
        .map((c) => semAcento(String(c)).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 2).slice(0, 5))
        .filter((ws) => ws.length)
        .slice(0, 6);
      const texto = `translate(lower(COALESCE(centro_custo, '') || ' ' || COALESCE(nome_fantasia, '')), '${COM_ACENTO}', '${SEM_ACENTO}')`;
      const filtroCentros = centros.length
        ? `AND (${centros.map((ws) => `(${ws.map((w) => `${texto} LIKE '%' || $${params.push(w)} || '%'`).join(" AND ")})`).join(" OR ")})`
        : "";
      const pReceita = `$${params.push(receita)}::numeric`;
      const pCusto = `$${params.push(custo)}::numeric`;
      const sql = `
        WITH os_do_dia AS (
          -- uma linha por OS: o valor do motoboy se repete em cada ponto
          SELECT DISTINCT ON (os) os, data_solicitado AS dia, cod_prof, nome_prof, centro_custo, valor_prof
            FROM bi_entregas
           WHERE ${FILTRO_CONCLUIDA} AND COALESCE(ponto, 1) >= 2 AND cod_prof IS NOT NULL
             AND cod_cliente = $${params.push(cod)} AND ${periodo} ${filtroCentros}
           ORDER BY os, ponto ASC
        ), por_motoboy AS (
          SELECT dia, cod_prof, MAX(nome_prof) AS profissional,
                 string_agg(DISTINCT centro_custo, ', ') AS centro_custo,
                 COUNT(*) AS os,
                 ROUND(SUM(COALESCE(valor_prof, 0))::numeric, 2) AS valor_motoboy
            FROM os_do_dia GROUP BY dia, cod_prof
        )
        SELECT dia, profissional, centro_custo, os, valor_motoboy,
               ${pReceita} AS receita, ${pCusto} AS custo_moto,
               ROUND(${pReceita} - ${pCusto} - valor_motoboy, 2) AS lucro,
               ROUND(100 * (${pReceita} - ${pCusto} - valor_motoboy) / ${pReceita}, 1) AS margem_pct
          FROM por_motoboy
         ORDER BY dia, lucro DESC`;
      return rodar(pool, tituloPeriodo("Margem por motoboy", inicio, fim), sql, params, (r) => {
        const motoboysDia = r.linhas.length;
        const pago = soma(r.linhas, "valor_motoboy");
        const lucro = Math.round(soma(r.linhas, "lucro") * 100) / 100;
        const receitaTotal = motoboysDia * receita;
        return {
          motoboys_dia: motoboysDia,
          os: soma(r.linhas, "os"),
          receita: receitaTotal,
          custo_moto: motoboysDia * custo,
          pago_motoboys: Math.round(pago * 100) / 100,
          lucro,
          margem_pct: pct(lucro, receitaTotal),
          motoboys_negativos: r.linhas.filter((l) => Number(l.lucro) < 0).length,
          centros: [...new Set(r.linhas.flatMap((l) => String(l.centro_custo ?? "").split(", ")).filter(Boolean))].join(", ") || null,
        };
      });
    },
  },
  {
    nome: "faturamento",
    descricao: "Faturamento num período (padrão: mês atual): valor cobrado, pago aos motoboys e margem, por cliente — sem duplicar valores por ponto.",
    parametros: { inicio: "AAAA-MM-DD (padrão: 1º dia do mês)", fim: "AAAA-MM-DD (padrão: hoje)", cliente: "nome (ou parte), opcional" },
    async executar(pool, p) {
      const params: unknown[] = [];
      const inicio = data(p.inicio);
      const fim = data(p.fim);
      const de = inicio ? `$${params.push(inicio)}::date` : `date_trunc('month', ${HOJE})::date`;
      const ate = fim ? `$${params.push(fim)}::date` : HOJE;
      const cliente = texto(p.cliente);
      const filtroCliente = cliente ? `AND nome_fantasia ILIKE '%' || $${params.push(cliente)} || '%'` : "";
      const sql = `
        WITH fat AS (
          SELECT DISTINCT ON (os) os, nome_fantasia, valor, valor_prof
            FROM bi_entregas
           WHERE ${FILTRO_CONCLUIDA} AND COALESCE(ponto, 1) >= 2 AND data_solicitado BETWEEN ${de} AND ${ate} ${filtroCliente}
           ORDER BY os, ponto ASC
        )
        SELECT nome_fantasia AS cliente, COUNT(*) AS os,
               ROUND(SUM(valor)::numeric, 2) AS cobrado,
               ROUND(SUM(valor_prof)::numeric, 2) AS pago_motoboys,
               ROUND((SUM(valor) - SUM(valor_prof))::numeric, 2) AS faturamento
          FROM fat GROUP BY nome_fantasia ORDER BY faturamento DESC NULLS LAST`;
      return rodar(pool, "Faturamento do período", sql, params, (r) => {
        const cobrado = soma(r.linhas, "cobrado");
        const faturamento = soma(r.linhas, "faturamento");
        return {
          cobrado: Math.round(cobrado * 100) / 100,
          pago_motoboys: Math.round(soma(r.linhas, "pago_motoboys") * 100) / 100,
          faturamento: Math.round(faturamento * 100) / 100,
          margem_pct: pct(faturamento, cobrado),
          os: soma(r.linhas, "os"),
        };
      });
    },
  },
  {
    nome: "saques",
    descricao:
      "Saques dos motoboys (todo saque pela Plific é o saque emergencial) por status: pedidos, motoboys distintos e valores. Período: inicio/fim (um dia = só inicio) ou os últimos N dias (padrão 30). Sem status, mostra todos; o total \"em aberto\" exclui pagos e rejeitados.",
    parametros: {
      inicio: "AAAA-MM-DD (opcional; um dia específico = só inicio)",
      fim: "AAAA-MM-DD (padrão = inicio)",
      periodo_dias: "últimos N dias, quando não houver inicio (padrão 30)",
      status: "filtrar um status (ex.: pago, rejeitado, aguardando_aprovacao), opcional",
    },
    async executar(pool, p) {
      const params: unknown[] = [];
      const inicio = data(p.inicio);
      const fim = data(p.fim) ?? inicio;
      const dias = Math.min(365, Math.max(1, Number(p.periodo_dias) || 30));
      const dia = `(created_at AT TIME ZONE 'America/Bahia')::date`;
      const periodo = inicio
        ? `${dia} BETWEEN $${params.push(inicio)}::date AND $${params.push(fim)}::date`
        : `created_at >= now() - make_interval(days => $${params.push(dias)})`;
      const status = texto(p.status);
      const filtroStatus = status ? `AND status = $${params.push(status)}` : "";
      const sql = `
        SELECT status, COUNT(*) AS pedidos,
               COUNT(DISTINCT user_cod) AS motoboys,
               ROUND(SUM(requested_amount)::numeric, 2) AS valor_pedido,
               ROUND(SUM(final_amount)::numeric, 2) AS valor_final,
               MIN(created_at) AS mais_antigo
          FROM withdrawal_requests
         WHERE ${periodo} ${filtroStatus}
         GROUP BY status ORDER BY pedidos DESC`;
      // Motoboys distintos no total (o mesmo motoboy pode ter saques em status diferentes).
      const total = await consultar(pool, `SELECT COUNT(*) AS pedidos, COUNT(DISTINCT user_cod) AS motoboys FROM withdrawal_requests WHERE ${periodo} ${filtroStatus}`, params, { limite: 1 });
      const titulo = inicio ? `Saques ${inicio === fim ? `de ${inicio}` : `de ${inicio} a ${fim}`}` : `Saques dos últimos ${dias} dias`;
      return rodar(pool, titulo, sql, params, (r) => {
        const abertos = r.linhas.filter((l) => !["pago", "rejeitado"].includes(String(l.status)));
        return {
          pedidos: Number(total.linhas[0]?.pedidos ?? 0),
          motoboys: Number(total.linhas[0]?.motoboys ?? 0),
          pedidos_em_aberto: soma(abertos, "pedidos"),
          valor_em_aberto: Math.round(soma(abertos, "valor_final") * 100) / 100,
          pagos: soma(r.linhas.filter((l) => l.status === "pago"), "pedidos"),
          valor_total: Math.round(soma(r.linhas, "valor_final") * 100) / 100,
        };
      });
    },
  },
];

export const consultaPronta = (nome: string) => CONSULTAS_PRONTAS.find((c) => c.nome === nome) ?? null;
