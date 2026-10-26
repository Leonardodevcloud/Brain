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
    descricao: "Entregas e SLA num período (padrão: hoje), por cliente: entregas, OS, % no prazo, fora do prazo, tempo médio, retornos.",
    parametros: { inicio: "AAAA-MM-DD (padrão hoje)", fim: "AAAA-MM-DD (padrão = inicio)", cliente: "nome (ou parte) do cliente, opcional" },
    async executar(pool, p) {
      const inicio = data(p.inicio);
      const fim = data(p.fim) ?? inicio;
      const cliente = texto(p.cliente);
      const params: unknown[] = [];
      const periodo = inicio ? `data_solicitado BETWEEN $${params.push(inicio)} AND $${params.push(fim)}` : `data_solicitado = ${HOJE}`;
      const filtroCliente = cliente ? `AND nome_fantasia ILIKE '%' || $${params.push(cliente)} || '%'` : "";
      const sql = `
        SELECT nome_fantasia AS cliente,
               COUNT(*) AS entregas,
               COUNT(DISTINCT os) AS os,
               ROUND(100.0 * COUNT(*) FILTER (WHERE dentro_prazo = true) / NULLIF(COUNT(*) FILTER (WHERE dentro_prazo IS NOT NULL), 0), 1) AS sla_pct,
               COUNT(*) FILTER (WHERE dentro_prazo = false) AS fora_prazo,
               ROUND(AVG(tempo_execucao_minutos) FILTER (WHERE tempo_execucao_minutos > 0 AND tempo_execucao_minutos < 480), 0) AS tempo_medio_min,
               COUNT(*) FILTER (WHERE LOWER(ocorrencia) LIKE '%retorno%' OR LOWER(ocorrencia) LIKE '%cliente fechado%'
                                   OR LOWER(ocorrencia) LIKE '%cliente ausente%' OR LOWER(ocorrencia) LIKE '%loja fechada%') AS retornos
          FROM bi_entregas
         WHERE COALESCE(ponto, 1) >= 2 AND ${periodo} ${filtroCliente}
         GROUP BY nome_fantasia
         ORDER BY entregas DESC`;
      return rodar(pool, inicio ? `Entregas de ${inicio}${fim !== inicio ? ` a ${fim}` : ""}` : "Entregas de hoje", sql, params, (r) => {
        const entregas = soma(r.linhas, "entregas");
        const fora = soma(r.linhas, "fora_prazo");
        return { entregas, os: soma(r.linhas, "os"), fora_prazo: fora, sla_pct: pct(entregas - fora, entregas), clientes: r.linhas.length, retornos: soma(r.linhas, "retornos") };
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
           WHERE COALESCE(ponto, 1) >= 2 AND data_solicitado BETWEEN ${de} AND ${ate} ${filtroCliente}
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
    descricao: "Saques dos motoboys por status (padrão: os que ainda não foram pagos nem rejeitados): quantidade e valores.",
    parametros: { periodo_dias: "considerar pedidos dos últimos N dias (padrão 30)" },
    async executar(pool, p) {
      const dias = Math.min(365, Math.max(1, Number(p.periodo_dias) || 30));
      const sql = `
        SELECT status, COUNT(*) AS pedidos,
               ROUND(SUM(requested_amount)::numeric, 2) AS valor_pedido,
               ROUND(SUM(final_amount)::numeric, 2) AS valor_final,
               MIN(created_at) AS mais_antigo
          FROM withdrawal_requests
         WHERE created_at >= now() - make_interval(days => $1)
         GROUP BY status ORDER BY pedidos DESC`;
      return rodar(pool, `Saques dos últimos ${dias} dias`, sql, [dias], (r) => {
        const abertos = r.linhas.filter((l) => !["pago", "rejeitado"].includes(String(l.status)));
        return {
          pedidos_em_aberto: soma(abertos, "pedidos"),
          valor_em_aberto: Math.round(soma(abertos, "valor_final") * 100) / 100,
          pagos: soma(r.linhas.filter((l) => l.status === "pago"), "pedidos"),
        };
      });
    },
  },
];

export const consultaPronta = (nome: string) => CONSULTAS_PRONTAS.find((c) => c.nome === nome) ?? null;
