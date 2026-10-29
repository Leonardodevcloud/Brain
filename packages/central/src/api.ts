/**
 * API da Central (tutts-backend): o Argos chama os MESMOS endpoints que as telas do BI e do
 * BI Financeiro usam, para chegar no mesmo número da tela. Só leitura e só o que está nesta lista:
 * o cliente aqui embaixo recusa qualquer método que não seja GET e qualquer rota fora do catálogo.
 *
 * Autenticação: cabeçalho `x-internal-secret` (o mesmo que os agentes de automação da Central usam).
 * O segredo fica só nas variáveis do servidor (CENTRAL_API_SEGREDO = INTERNAL_SECRET da Central).
 */

export interface EndpointCentral {
  /** Nome que a IA usa ("bi.dashboard"). */
  id: string;
  caminho: string;
  modulo: "bi" | "financeiro";
  descricao: string;
  /** Parâmetros de query aceitos (nome → o que é). Qualquer outro é descartado. */
  parametros: Record<string, string>;
  obrigatorios?: string[];
  /** A tabela mais útil da resposta, quando a IA não escolhe uma. */
  tabelaPadrao?: string;
}

const PERIODO = {
  data_inicio: "AAAA-MM-DD",
  data_fim: "AAAA-MM-DD",
};
const FILTROS_BI = {
  ...PERIODO,
  cod_cliente: "código(s) do cliente, separados por vírgula",
  centro_custo: "centro de custo (filial/loja do cliente)",
  cod_prof: "código do motoboy",
  categoria: "categoria do veículo/serviço",
  cidade: "cidade",
  status_prazo: "dentro | fora",
  tipo_operacao: "tipo de operação",
};

export const ENDPOINTS_CENTRAL: EndpointCentral[] = [
  // ── BI de entregas ──
  {
    id: "bi.dashboard",
    caminho: "/api/bi/dashboard-completo",
    modulo: "bi",
    descricao:
      "Painel do BI de entregas, igual à tela: metricas (OS, entregas, no prazo, fora do prazo, taxa de prazo, retornos, valor cobrado, valor do motoboy, ticket médio, tempos médios), porCliente, porProfissional e porHora.",
    parametros: FILTROS_BI,
    obrigatorios: ["data_inicio", "data_fim"],
    tabelaPadrao: "porCliente",
  },
  {
    id: "bi.dashboard_rapido",
    caminho: "/api/bi/dashboard-rapido",
    modulo: "bi",
    descricao: "Números gerais do período (resumo diário pré-calculado): OS, entregas, taxa de prazo, retornos, valores, ticket e tempos médios.",
    parametros: { ...PERIODO, cod_cliente: FILTROS_BI.cod_cliente, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.resumo_clientes",
    caminho: "/api/bi/resumo-clientes",
    modulo: "bi",
    descricao: "Tabela por cliente da tela do BI (entregas, prazo, valores, tempos).",
    parametros: FILTROS_BI,
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.resumo_profissionais",
    caminho: "/api/bi/resumo-profissionais",
    modulo: "bi",
    descricao: "Tabela por motoboy da tela do BI (entregas, prazo, tempos, valor).",
    parametros: FILTROS_BI,
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.acompanhamento",
    caminho: "/api/bi/acompanhamento-periodico",
    modulo: "bi",
    descricao: "Evolução no tempo (aba Acompanhamento): entregas, prazo e retornos por dia.",
    parametros: { ...FILTROS_BI, status_retorno: "com | sem retorno" },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.comparativo_semanal",
    caminho: "/api/bi/comparativo-semanal",
    modulo: "bi",
    descricao: "Comparativo semana a semana com as variações entre semanas.",
    parametros: { ...PERIODO, cod_cliente: FILTROS_BI.cod_cliente, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.comparativo_semanal_clientes",
    caminho: "/api/bi/comparativo-semanal-clientes",
    modulo: "bi",
    descricao: "Comparativo semanal detalhado por cliente.",
    parametros: { ...PERIODO, cod_cliente: FILTROS_BI.cod_cliente, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.acompanhamento_clientes",
    caminho: "/api/bi/acompanhamento-clientes",
    modulo: "bi",
    descricao: "Acompanhamento por cliente, agrupado por nome fantasia (como o Power BI).",
    parametros: { ...FILTROS_BI, status_retorno: "com | sem retorno" },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.cliente_767",
    caminho: "/api/bi/cliente-767",
    modulo: "bi",
    descricao: "Visão especial do Grupo Comollati (cliente 767), com prazo fixo de 120 minutos.",
    parametros: { ...PERIODO, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.serie_temporal",
    caminho: "/api/bi/serie-temporal",
    modulo: "bi",
    descricao: "Série no tempo das métricas do BI, por dia, semana ou mês.",
    parametros: { ...FILTROS_BI, granularidade: "dia | semana | mes", regiao: "região" },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.graficos",
    caminho: "/api/bi/graficos",
    modulo: "bi",
    descricao: "Distribuição das entregas por faixas de tempo e de km.",
    parametros: FILTROS_BI,
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.garantido",
    caminho: "/api/bi/garantido",
    modulo: "bi",
    descricao: "Garantido dos motoboys (mínimo garantido x produzido) no período.",
    parametros: { ...PERIODO, cod_cliente: FILTROS_BI.cod_cliente, cod_prof: FILTROS_BI.cod_prof, filtro_status: "status do garantido" },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.garantido_semanal",
    caminho: "/api/bi/garantido/semanal",
    modulo: "bi",
    descricao: "Garantido por semana e por cliente.",
    parametros: PERIODO,
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.garantido_por_cliente",
    caminho: "/api/bi/garantido/por-cliente",
    modulo: "bi",
    descricao: "Garantido detalhado por cliente e motoboy.",
    parametros: { ...PERIODO, cod_cliente: FILTROS_BI.cod_cliente, cod_prof: FILTROS_BI.cod_prof },
    obrigatorios: ["data_inicio", "data_fim"],
  },
  {
    id: "bi.escala_panorama",
    caminho: "/api/bi/escala/panorama",
    modulo: "bi",
    descricao: "Panorama da escala: quem rodou por dia e loja comparado ao mínimo de escala.",
    parametros: { de: "AAAA-MM-DD", ate: "AAAA-MM-DD", cod_cliente: FILTROS_BI.cod_cliente, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["de", "ate"],
  },
  {
    id: "bi.escala_dia",
    caminho: "/api/bi/escala/dia",
    modulo: "bi",
    descricao: "Escala de um dia: quem rodou e quem costuma rodar e não apareceu.",
    parametros: { data: "AAAA-MM-DD", cod_cliente: FILTROS_BI.cod_cliente, centro_custo: FILTROS_BI.centro_custo },
    obrigatorios: ["data"],
  },
  { id: "bi.prazos", caminho: "/api/bi/prazos", modulo: "bi", descricao: "Faixas de prazo de entrega configuradas por cliente (regra de dentro/fora do prazo).", parametros: {} },
  { id: "bi.prazos_profissional", caminho: "/api/bi/prazos-prof", modulo: "bi", descricao: "Faixas de prazo do motoboy (prazo profissional).", parametros: {} },
  { id: "bi.regras_contagem", caminho: "/api/bi/regras-contagem", modulo: "bi", descricao: "Regras de contagem de entregas configuradas no BI.", parametros: {} },
  { id: "bi.clientes", caminho: "/api/bi/clientes", modulo: "bi", descricao: "Lista de clientes do BI (código e nome), para achar o código de um cliente.", parametros: {} },
  { id: "bi.centros_custo", caminho: "/api/bi/cliente-centros", modulo: "bi", descricao: "Relação cliente → centros de custo (lojas/filiais).", parametros: {} },
  { id: "bi.regioes", caminho: "/api/bi/regioes", modulo: "bi", descricao: "Regiões cadastradas no BI.", parametros: {} },

  // ── BI Financeiro e financeiro ──
  {
    id: "fin.painel",
    caminho: "/api/financial/bi-financeiro/painel",
    modulo: "financeiro",
    descricao:
      "Painel do BI Financeiro, igual à tela: totais (bruto, repasse aos motoboys, garantido, margem) do período e do período anterior, dias, semanas, veículos, clientes (com centros de custo) e análises/projeção do mês.",
    parametros: { ...PERIODO, clientes: "códigos de cliente separados por vírgula", ccs: "centros de custo", categorias: "categorias de veículo", agrupar: "1 agrupa centros pequenos; 0 não" },
    obrigatorios: ["data_inicio", "data_fim"],
    tabelaPadrao: "clientes",
  },
  { id: "fin.evolucao", caminho: "/api/financial/bi-financeiro/evolucao", modulo: "financeiro", descricao: "Evolução mês a mês do BI Financeiro até a data.", parametros: { data_fim: "AAAA-MM-DD" }, tabelaPadrao: "meses" },
  { id: "fin.parametros", caminho: "/api/financial/bi-financeiro/params", modulo: "financeiro", descricao: "Parâmetros e metas do BI Financeiro (faixas de km, metas).", parametros: {} },
  { id: "fin.saques_resumo", caminho: "/api/withdrawals/resumo-contadores", modulo: "financeiro", descricao: "Resumo dos saques: quantos e quanto por status.", parametros: {} },
  {
    id: "fin.saques_historico",
    caminho: "/api/withdrawals/historico",
    modulo: "financeiro",
    descricao: "Histórico de saques dos motoboys (paginado), com status e valores.",
    parametros: { ...PERIODO, status: "status do saque", page: "página", limit: "itens por página (até 200)" },
  },
  { id: "fin.conciliacao", caminho: "/api/withdrawals/dashboard/conciliacao", modulo: "financeiro", descricao: "Painel de conciliação dos saques.", parametros: {} },
  { id: "fin.gratuidades", caminho: "/api/gratuities/kpis", modulo: "financeiro", descricao: "Indicadores das gratuidades de saque (ativas, usadas, expiradas).", parametros: {} },
  { id: "fin.isencoes", caminho: "/api/exemptions/kpis", modulo: "financeiro", descricao: "Indicadores das isenções permanentes de taxa de saque.", parametros: {} },
  { id: "fin.taxa_fixa", caminho: "/api/taxa-fixa/kpis", modulo: "financeiro", descricao: "Indicadores da taxa fixa de saque por motoboy.", parametros: {} },
  { id: "fin.sinistros", caminho: "/api/sinistros/cards", modulo: "financeiro", descricao: "Cartões da apuração de sinistros no período.", parametros: PERIODO },
  { id: "fin.comissao", caminho: "/api/comissao/painel", modulo: "financeiro", descricao: "Painel de comissões dos vendedores na competência.", parametros: { competencia: "AAAA-MM" } },
];

export const endpointCentral = (id: string) => ENDPOINTS_CENTRAL.find((e) => e.id === id) ?? null;

/** Para o prompt do agente: uma linha por endpoint. */
export const resumoEndpointsCentral = () =>
  ENDPOINTS_CENTRAL.map((e) => {
    const ps = Object.entries(e.parametros)
      .map(([k, v]) => `${k}${e.obrigatorios?.includes(k) ? "*" : ""}=${v}`)
      .join("; ");
    return `- ${e.id}: ${e.descricao}${ps ? ` Parâmetros: ${ps}` : ""}`;
  }).join("\n");

// Campos que nunca saem da resposta (nem para a tela, nem para a IA).
const CAMPO_SENSIVEL = /(^|_)(cpf|cnpj_prof|pix|chave_?pix|tipo_?chave|banco|agencia|ag|conta|conta_?corrente|senha|token|telefone|celular|whatsapp|email|e_mail|endereco|cep|rg|cnh|placa|foto|selfie|documento)($|_)/i;

/** Remove os campos sensíveis em qualquer nível da resposta. */
export function limparSensiveis(v: unknown, nivel = 0): unknown {
  if (nivel > 8) return null;
  if (Array.isArray(v)) return v.map((x) => limparSensiveis(x, nivel + 1));
  if (v && typeof v === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (CAMPO_SENSIVEL.test(k.normalize("NFD").replace(/[̀-ͯ]/g, ""))) continue;
      saida[k] = limparSensiveis(x, nivel + 1);
    }
    return saida;
  }
  return v;
}

export interface TabelaResposta {
  caminho: string;
  linhas: Record<string, unknown>[];
}

const ehLinha = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const escalar = (x: unknown) => x === null || ["string", "number", "boolean"].includes(typeof x);

/**
 * Lê uma resposta qualquer da Central: os números soltos (totais/metricas) e as tabelas
 * (listas de objetos) até dois níveis de profundidade. Objetos dentro das linhas viram colunas "a_b".
 */
export function lerRespostaCentral(resposta: unknown): { numeros: Record<string, unknown>; tabelas: TabelaResposta[] } {
  const numeros: Record<string, unknown> = {};
  const tabelas: TabelaResposta[] = [];
  const achatar = (l: Record<string, unknown>) => {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(l)) {
      if (escalar(v)) saida[k] = v;
      else if (ehLinha(v)) for (const [k2, v2] of Object.entries(v)) if (escalar(v2)) saida[`${k}_${k2}`] = v2;
    }
    return saida;
  };
  const visitar = (v: unknown, caminho: string, nivel: number) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(ehLinha)) tabelas.push({ caminho: caminho || "linhas", linhas: v.map(achatar) });
      return;
    }
    if (!ehLinha(v) || nivel > 2) return;
    for (const [k, x] of Object.entries(v)) {
      const c = caminho ? `${caminho}.${k}` : k;
      if (escalar(x)) {
        if (nivel <= 2) numeros[c] = x;
      } else visitar(x, c, nivel + 1);
    }
  };
  visitar(resposta, "", 0);
  return { numeros, tabelas };
}

/** Cliente HTTP só leitura para a API da Central. */
export class ClienteApiCentral {
  private cache = new Map<string, { em: number; dados: unknown }>();

  constructor(private readonly cfg: { url: string; segredo: string; timeoutMs?: number }) {}

  /** Chama um endpoint do catálogo com parâmetros conferidos. */
  async consultar(id: string, parametros: Record<string, unknown> = {}): Promise<{ endpoint: EndpointCentral; dados: unknown; ms: number; url: string }> {
    const e = endpointCentral(id);
    if (!e) throw new Error(`Endpoint "${id}" não existe. Use um de: ${ENDPOINTS_CENTRAL.map((x) => x.id).join(", ")}.`);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(parametros)) {
      if (!(k in e.parametros) || v === null || v === undefined || v === "") continue;
      const valor = Array.isArray(v) ? v.join(",") : String(v);
      if (/data|^de$|^ate$/.test(k) && !/^\d{4}-\d{2}-\d{2}$/.test(valor)) throw new Error(`O parâmetro ${k} precisa ser AAAA-MM-DD.`);
      if (k === "competencia" && !/^\d{4}-\d{2}$/.test(valor)) throw new Error("competencia precisa ser AAAA-MM.");
      if (k === "limit" && Number(valor) > 200) q.set(k, "200");
      else q.set(k, valor.slice(0, 200));
    }
    for (const o of e.obrigatorios ?? []) if (!q.has(o)) throw new Error(`Faltou o parâmetro ${o} (${e.parametros[o]}).`);
    const caminho = `${e.caminho}${q.size ? `?${q}` : ""}`;
    const guardado = this.cache.get(caminho);
    if (guardado && Date.now() - guardado.em < 60_000) return { endpoint: e, dados: guardado.dados, ms: 0, url: caminho };

    const inicio = Date.now();
    // Só GET, só caminhos do catálogo: nada aqui consegue alterar a Central.
    const resposta = await fetch(`${this.cfg.url.replace(/\/$/, "")}${caminho}`, {
      method: "GET",
      headers: { "x-internal-secret": this.cfg.segredo, accept: "application/json", "user-agent": "second-brain-argos" },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 25_000),
    });
    const texto = await resposta.text();
    if (!resposta.ok) throw new Error(`A Central respondeu ${resposta.status} em ${e.id}: ${texto.slice(0, 200)}`);
    if (texto.length > 6_000_000) throw new Error(`A resposta de ${e.id} veio grande demais; filtre mais (período menor ou um cliente).`);
    const dados = limparSensiveis(JSON.parse(texto));
    this.cache.set(caminho, { em: Date.now(), dados });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return { endpoint: e, dados, ms: Date.now() - inicio, url: caminho };
  }

  /** Para Integrações: a Central responde com esse segredo? */
  async testar() {
    await this.consultar("bi.regioes");
    return true;
  }
}
