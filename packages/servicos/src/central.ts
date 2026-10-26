import {
  CONSULTAS_PRONTAS,
  REGRAS_NEGOCIO,
  carregarCatalogo,
  consultaPronta,
  consultar,
  detalharTabelas,
  resumoDoCatalogo,
  validarSql,
  type ResultadoPronto,
} from "@cerebro/central";
import { AppError, type DadosCentralDTO } from "@cerebro/core";
import {
  SISTEMA_ANALISE_DADOS,
  SISTEMA_PLANO_DADOS,
  SISTEMA_SQL,
  lerJson,
  mascarar,
  montarPedidoAnalise,
  montarPedidoPlano,
  montarPedidoSql,
  restaurar,
  type AnaliseDados,
  type PlanoDados,
  type SqlGerado,
} from "@cerebro/ia";
import { auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";

const LINHAS_PARA_IA = 60;
const LINHAS_PARA_TELA = 50;
// Colunas com nomes de pessoas: o valor é mascarado antes de ir para a IA.
const COLUNA_DE_PESSOA = /(^|_)(nome_prof|nome_profissional|profissional|motoboy|user_name|full_name|nome_motoboy|colaborador|vendedor|gestor|responsavel)($|_)/i;

/** Regras rápidas para responder sem IA as perguntas mais comuns. */
export function planoRapido(pergunta: string): PlanoDados | null {
  const t = pergunta.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/disponib|escala|motoboys? (na|nas) loja|em loja|faltando/.test(t)) {
    // "disponibilidade em Salvador", "na regiao de Feira de Santana" → filtra a região e abre por loja.
    const lugar = /\b(?:em|na|no|regiao(?: de)?|praca(?: de)?)\s+(?!loja|lojas\b|cada\b|tempo\b|turno|momento|periodo|hora|regiao|praca)([a-z][a-z]+(?:\s+(?:de\s+|do\s+|da\s+)?[a-z]+){0,3}?)\s*(?:agora|hoje|neste momento|nesse momento)?\s*[?.!]*$/.exec(t);
    const regiao = lugar?.[1]?.trim();
    const parametros: Record<string, string> = {};
    if (regiao && regiao.length >= 3) Object.assign(parametros, { regiao, por: "loja" });
    else if (/por loja|cada loja/.test(t)) parametros.por = "loja";
    return { ferramenta: "disponibilidade", parametros, tabelas: [] };
  }
  if (/fatur|margem|receita/.test(t)) return { ferramenta: "faturamento", parametros: {}, tabelas: [] };
  if (/saque/.test(t)) return { ferramenta: "saques", parametros: {}, tabelas: [] };
  if (/entrega|sla|no prazo|fora do prazo/.test(t) && /hoje|agora/.test(t)) return { ferramenta: "entregas", parametros: {}, tabelas: [] };
  return null;
}

function exigirCentral(ctx: Contexto) {
  if (!ctx.central) {
    throw AppError.indisponivel("O Argos ainda não está ligado à Central. Defina ARGOS_DB_SENHA no Railway.");
  }
  return ctx.central;
}

async function planejar(ctx: Contexto, pergunta: string): Promise<PlanoDados> {
  const central = exigirCentral(ctx);
  const rapido = !ctx.ia ? planoRapido(pergunta) : null;
  if (rapido) return rapido;
  if (!ctx.ia) {
    throw AppError.indisponivel("Para perguntas livres sobre a Central, ligue o DeepSeek (IA_ANALISE_CHAVE). Sem ele, pergunte sobre disponibilidade, entregas de hoje, faturamento ou saques.");
  }
  const catalogo = await carregarCatalogo(central);
  const prontas = CONSULTAS_PRONTAS.map((c) => `- ${c.nome}: ${c.descricao} Parâmetros: ${JSON.stringify(c.parametros)}`).join("\n");
  const bruto = await ctx.ia.gerar({
    sistema: SISTEMA_PLANO_DADOS,
    mensagens: [{ papel: "user", conteudo: montarPedidoPlano(pergunta, hojeLocal(ctx.agora()), prontas, resumoDoCatalogo(catalogo)) }],
    json: true,
    temperatura: 0,
    maxTokens: 500,
  });
  const plano = lerJson<PlanoDados>(bruto);
  const nomes = new Set(catalogo.map((t) => t.nome));
  return {
    ferramenta: plano.ferramenta === "sql" || consultaPronta(plano.ferramenta) ? plano.ferramenta : "sql",
    parametros: plano.parametros ?? {},
    tabelas: (plano.tabelas ?? []).filter((t) => nomes.has(t)).slice(0, 8),
  };
}

/** Gera, confere e executa o SQL; se o banco reclamar, a IA corrige uma vez. */
async function consultaLivre(ctx: Contexto, pergunta: string, tabelas: string[]): Promise<ResultadoPronto & { explicacao: string }> {
  const central = exigirCentral(ctx);
  if (!ctx.ia) throw AppError.indisponivel("Consulta livre precisa do DeepSeek.");
  if (!tabelas.length) throw AppError.requisicaoInvalida("Não achei no sistema da Central onde ficam esses dados.");
  const catalogo = await carregarCatalogo(central);
  const detalhe = detalharTabelas(catalogo, tabelas);
  let anterior: { sql: string; erro: string } | undefined;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const bruto = await ctx.ia.gerar({
      sistema: SISTEMA_SQL,
      mensagens: [{ papel: "user", conteudo: montarPedidoSql(pergunta, hojeLocal(ctx.agora()), REGRAS_NEGOCIO, detalhe, anterior) }],
      json: true,
      temperatura: 0,
      maxTokens: 1500,
    });
    const gerado = lerJson<SqlGerado>(bruto);
    let sql = "";
    try {
      sql = validarSql(gerado.sql ?? "");
      const r = await consultar(central, sql, [], { limite: 200 });
      return { ...r, titulo: gerado.explicacao || "Consulta à Central", sql, totais: {}, explicacao: gerado.explicacao ?? "" };
    } catch (erro) {
      anterior = { sql: sql || gerado.sql, erro: (erro as Error).message.slice(0, 400) };
      ctx.log.warn({ erro: anterior.erro }, "consulta livre falhou; tentando corrigir");
    }
  }
  throw AppError.indisponivel("Não consegui montar essa consulta. Tente perguntar de outro jeito, com o período e o cliente.");
}

const formatarNumero = (v: unknown) =>
  typeof v === "number" ? v.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : String(v ?? "—");

/** Fala e destaques sem IA, para as consultas prontas. */
function falaSemIa(nome: string, t: ResultadoPronto["totais"], parametros: Record<string, unknown> = {}): Pick<AnaliseDados, "fala" | "destaques"> {
  const n = (k: string) => formatarNumero(t[k]);
  const reais = (k: string) => (typeof t[k] === "number" ? (t[k] as number).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—");
  switch (nome) {
    case "disponibilidade": {
      const regiao = typeof parametros.regiao === "string" ? parametros.regiao.replace(/(^|\s)(?!(?:de|da|do)\b)(\p{L})/gu, (_m, e: string, l: string) => e + l.toUpperCase()) : "";
      if (regiao && !t.titulares) return { fala: `Não encontrei a região ${regiao} na disponibilidade de agora.`, destaques: [] };
      return {
        fala: `${regiao ? `Em ${regiao}, agora` : "Agora"} são ${n("em_loja")} motoboys em loja de ${n("titulares")} vagas titulares, ${n("pct_em_loja")}%. ${n("faltando")} faltando, ${n("sem_contato")} sem contato e ${n("a_confirmar")} a confirmar.`,
        destaques: [
          { rotulo: "Em loja", valor: `${n("em_loja")} de ${n("titulares")}` },
          { rotulo: "% em loja", valor: `${n("pct_em_loja")}%` },
          { rotulo: "Faltando", valor: n("faltando") },
          { rotulo: "Vagas abertas", valor: n("vagas_abertas") },
        ],
      };
    }
    case "entregas":
      return {
        fala: `Hoje foram ${n("entregas")} entregas em ${n("os")} OS, com ${n("sla_pct")}% no prazo e ${n("fora_prazo")} fora do prazo.`,
        destaques: [
          { rotulo: "Entregas", valor: n("entregas") },
          { rotulo: "No prazo", valor: `${n("sla_pct")}%` },
          { rotulo: "Fora do prazo", valor: n("fora_prazo") },
          { rotulo: "Retornos", valor: n("retornos") },
        ],
      };
    case "faturamento":
      return {
        fala: `O faturamento do período está em ${reais("faturamento")}, com ${reais("cobrado")} cobrados e margem de ${n("margem_pct")}%.`,
        destaques: [
          { rotulo: "Faturamento", valor: reais("faturamento") },
          { rotulo: "Cobrado", valor: reais("cobrado") },
          { rotulo: "Pago aos motoboys", valor: reais("pago_motoboys") },
          { rotulo: "Margem", valor: `${n("margem_pct")}%` },
        ],
      };
    case "saques":
      return {
        fala: `Há ${n("pedidos_em_aberto")} saques em aberto, somando ${reais("valor_em_aberto")}.`,
        destaques: [
          { rotulo: "Em aberto", valor: n("pedidos_em_aberto") },
          { rotulo: "Valor em aberto", valor: reais("valor_em_aberto") },
          { rotulo: "Pagos", valor: n("pagos") },
        ],
      };
    default:
      return { fala: "Consulta feita. Os números estão abaixo.", destaques: [] };
  }
}

async function analisar(ctx: Contexto, pergunta: string, r: ResultadoPronto): Promise<AnaliseDados | null> {
  if (!ctx.ia) return null;
  const amostra = r.linhas.slice(0, LINHAS_PARA_IA);
  const nomes = new Set<string>();
  for (const l of amostra) for (const [col, v] of Object.entries(l)) if (COLUNA_DE_PESSOA.test(col) && typeof v === "string") nomes.add(v);
  const { texto, mapa } = mascarar(
    montarPedidoAnalise(pergunta, r.titulo, JSON.stringify(r.totais), JSON.stringify(amostra), r.cortado || r.linhas.length > LINHAS_PARA_IA),
    { nomes: [...nomes] },
  );
  try {
    const bruto = await ctx.ia.gerar({
      sistema: SISTEMA_ANALISE_DADOS,
      mensagens: [{ papel: "user", conteudo: texto }],
      json: true,
      temperatura: 0.2,
      maxTokens: 900,
    });
    const a = lerJson<AnaliseDados>(restaurar(bruto, mapa));
    return { fala: a.fala ?? "", analise: a.analise ?? "", destaques: (a.destaques ?? []).slice(0, 4) };
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "análise dos dados falhou; mostrando só os números");
    return null;
  }
}

/** Responde uma pergunta sobre a operação consultando o banco da Central (só leitura). */
export async function consultarCentral(ctx: Contexto, ator: Ator, pergunta: string): Promise<{ fala: string; dados: DadosCentralDTO }> {
  const plano = await planejar(ctx, pergunta);
  const pronta = plano.ferramenta !== "sql" ? consultaPronta(plano.ferramenta) : null;
  const resultado = pronta
    ? { ...(await pronta.executar(exigirCentral(ctx), plano.parametros)), explicacao: pronta.descricao }
    : await consultaLivre(ctx, pergunta, plano.tabelas);

  const analise = await analisar(ctx, pergunta, resultado);
  const semIa = pronta ? falaSemIa(pronta.nome, resultado.totais, plano.parametros) : { fala: "", destaques: [] };
  const fala =
    analise?.fala ||
    semIa.fala ||
    (resultado.linhas.length ? `Encontrei ${resultado.linhas.length} linhas para isso. Os números estão na tela.` : "Não há dados para isso no período.");

  await auditar(ctx.pool, ator, "argos.consulta_central", undefined, {
    pergunta: pergunta.slice(0, 300),
    origem: pronta ? `pronta:${pronta.nome}` : "livre",
    linhas: resultado.linhas.length,
    ms: resultado.ms,
  });

  return {
    fala,
    dados: {
      titulo: resultado.titulo,
      origem: pronta ? "pronta" : "livre",
      colunas: resultado.colunas,
      linhas: resultado.linhas.slice(0, LINHAS_PARA_TELA),
      cortado: resultado.cortado || resultado.linhas.length > LINHAS_PARA_TELA,
      totais: resultado.totais,
      destaques: analise?.destaques?.length ? analise.destaques : semIa.destaques,
      analise: analise?.analise || null,
      sql: resultado.sql,
      explicacao: resultado.explicacao || null,
      tabelas: pronta ? [] : plano.tabelas,
      ms: resultado.ms,
    },
  };
}
