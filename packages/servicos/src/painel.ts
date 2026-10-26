import { randomBytes } from "node:crypto";
import {
  AppError,
  type ResumoInicioDTO,
  type StatusIntegracaoDTO,
} from "@cerebro/core";
import { auditoria, integracoes, jobs, lacunas, registros, reunioes, trechos, tokensConector } from "@cerebro/db";
import type { MapaTarefasNotion } from "@cerebro/integracoes";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { lerMapaNotion } from "./fontes.js";
import { paraResumo } from "./registros.js";

const DESCRICAO_ACAO: Record<string, string> = {
  "registro.publicado": "publicou",
  "registro.rascunho": "criou o rascunho",
  "registro.aprovado": "aprovou",
  "registro.editado": "editou",
  "registro.revisado": "confirmou que segue válido",
  "registro.descartado": "descartou",
  "registro.obsoleto": "marcou como obsoleto",
  "notion.tarefas": "criou tarefas no Notion a partir de",
  "reuniao.recebida": "recebeu uma reunião gravada",
  "importacao.claude": "importou conversas do Claude",
};

// ───────────────────────────── Google Agenda ─────────────────────────────

/** Link de autorização do Google. O `estado` amarra o retorno a quem pediu. */
export async function iniciarConexaoGoogle(ctx: Contexto, ator: Ator) {
  if (!ctx.google) throw AppError.indisponivel("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.");
  if (!ctx.cofre) throw AppError.indisponivel("Configure CEREBRO_CHAVE_CIFRA para guardar o acesso com segurança.");
  if (ator.papel !== "admin") throw AppError.semPermissao("Só o administrador conecta a agenda.");
  const estado = randomBytes(24).toString("base64url");
  await integracoes.salvar(ctx.pool, "google_estado", {
    config: { estado, usuarioId: ator.usuarioId, expiraEm: new Date(ctx.agora().getTime() + 600_000).toISOString() },
  });
  return ctx.google.urlAutorizacao(estado);
}

export async function concluirConexaoGoogle(ctx: Contexto, codigo: string, estado: string) {
  if (!ctx.google || !ctx.cofre) throw AppError.indisponivel("Google Agenda não configurado.");
  const pendente = await integracoes.obter(ctx.pool, "google_estado");
  const cfg = pendente?.config as { estado?: string; usuarioId?: string; expiraEm?: string } | undefined;
  if (!cfg?.estado || cfg.estado !== estado || !cfg.expiraEm || new Date(cfg.expiraEm) < ctx.agora()) {
    throw AppError.requisicaoInvalida("O pedido de conexão expirou. Tente conectar de novo.");
  }
  const { refreshToken, accessToken } = await ctx.google.trocarCodigo(codigo);
  await ctx.google.listarEventos(accessToken, ctx.agora(), new Date(ctx.agora().getTime() + 86_400_000));
  await integracoes.salvar(ctx.pool, "google", {
    config: { conectadoEm: ctx.agora().toISOString() },
    segredo: ctx.cofre.cifrar(refreshToken),
  });
  await integracoes.salvar(ctx.pool, "google_estado", { config: {} });
  await auditar(ctx.pool, { usuarioId: cfg.usuarioId ?? null, papel: "admin", canal: "web" }, "google.conectado");
}

export async function proximasReunioes(ctx: Contexto, horas = 36) {
  if (!ctx.google || !ctx.cofre) return [];
  const salvo = await integracoes.obter(ctx.pool, "google");
  if (!salvo?.segredo) return [];
  try {
    const acesso = await ctx.google.acessoPorRefresh(ctx.cofre.decifrar(salvo.segredo));
    const agora = ctx.agora();
    const eventos = await ctx.google.listarEventos(acesso, agora, new Date(agora.getTime() + horas * 3_600_000));
    return eventos.slice(0, 6).map((e) => ({ titulo: e.titulo, inicio: e.inicio, link: e.link }));
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "não foi possível ler a agenda");
    return [];
  }
}

// ───────────────────────────── Notion ─────────────────────────────

export async function colunasNotion(ctx: Contexto, databaseId: string) {
  if (!ctx.notion) throw AppError.indisponivel("Configure NOTION_TOKEN.");
  return ctx.notion.lerColunas(databaseId);
}

export async function salvarMapaNotion(ctx: Contexto, ator: Ator, mapa: MapaTarefasNotion) {
  if (ator.papel !== "admin") throw AppError.semPermissao();
  if (!ctx.notion) throw AppError.indisponivel("Configure NOTION_TOKEN.");
  const { colunas } = await ctx.notion.lerColunas(mapa.databaseId);
  const existe = new Set(colunas.map((c) => c.nome));
  for (const prop of [mapa.propTitulo, mapa.propPrazo, mapa.propResponsavel, mapa.propStatus, mapa.propOrigem]) {
    if (prop && !existe.has(prop)) throw AppError.requisicaoInvalida(`A coluna "${prop}" não existe neste banco do Notion.`);
  }
  await integracoes.salvar(ctx.pool, "notion", { config: { ...mapa } });
  await auditar(ctx.pool, ator, "notion.configurado");
}

// ───────────────────────────── Status e início ─────────────────────────────

export async function statusIntegracoes(ctx: Contexto, ator: Ator): Promise<StatusIntegracaoDTO[]> {
  const [google, mapaNotion, email, ultimaReuniao, contagemTrechos, tokens, importacao] = await Promise.all([
    integracoes.obter(ctx.pool, "google"),
    lerMapaNotion(ctx),
    integracoes.obter(ctx.pool, "email"),
    reunioes.ultima(ctx.pool),
    trechos.contar(ctx.pool),
    ator.usuarioId ? tokensConector.listarDoUsuario(ctx.pool, ator.usuarioId) : Promise.resolve([]),
    integracoes.obter(ctx.pool, "claude_importacao"),
  ]);
  const quando = (d: Date | string | null | undefined) =>
    d ? new Date(d).toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "short" }) : null;

  return [
    {
      nome: "claude",
      estado: tokens.length ? "ativo" : "incompleto",
      detalhe: tokens.length
        ? `${tokens.length} token(s) ativo(s). Última importação do histórico: ${quando(importacao?.config.ultimaEm as string) ?? "nunca"}.`
        : "Crie um token para conectar o Claude ao cérebro.",
    },
    {
      nome: "fathom",
      estado: ctx.ambiente.FATHOM_WEBHOOK_SEGREDO ? "ativo" : "desligado",
      detalhe: ctx.ambiente.FATHOM_WEBHOOK_SEGREDO
        ? `Última reunião recebida: ${quando(ultimaReuniao) ?? "nenhuma ainda"}.`
        : "Defina FATHOM_WEBHOOK_SEGREDO e cadastre o webhook na Fathom.",
    },
    {
      nome: "google",
      estado: !ctx.google ? "desligado" : google?.segredo ? "ativo" : "incompleto",
      detalhe: !ctx.google
        ? "Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET."
        : google?.segredo
          ? `Conectado em ${quando(google.config.conectadoEm as string)}.`
          : "Falta autorizar o acesso à agenda.",
    },
    {
      nome: "notion",
      estado: !ctx.notion ? "desligado" : mapaNotion ? "ativo" : "incompleto",
      detalhe: !ctx.notion ? "Defina NOTION_TOKEN." : mapaNotion ? "Banco de tarefas configurado." : "Falta escolher o banco de tarefas.",
    },
    {
      nome: "email",
      estado: ctx.imap ? "ativo" : "desligado",
      detalhe: ctx.imap
        ? `${ctx.imap.usuario} · última leitura: ${quando(email?.config.ultimaLeituraEm as string) ?? "ainda não lida"}.`
        : "Defina IMAP_HOST, IMAP_USUARIO e IMAP_SENHA da caixa dedicada.",
    },
    {
      nome: "deepseek",
      estado: ctx.ia ? "ativo" : "desligado",
      detalhe: ctx.ia
        ? `${ctx.ia.nome}. Dados pessoais mascarados antes do envio.${ctx.iaRestrita ? " Conteúdo restrito vai para o provedor seguro." : ""}`
        : "Defina IA_ANALISE_CHAVE para respostas, atas e importações.",
    },
    {
      nome: "embeddings",
      estado: ctx.embeddings ? "ativo" : "desligado",
      detalhe: ctx.embeddings
        ? `${contagemTrechos.comVetor} de ${contagemTrechos.total} trechos com vetor.`
        : "Sem GEMINI_CHAVE a busca funciona só por texto.",
    },
  ];
}

export async function resumoInicio(ctx: Contexto): Promise<ResumoInicioDTO> {
  const [paraRevisar, vencidos, proximas, atividade] = await Promise.all([
    registros.listarParaRevisao(ctx.pool, 5),
    registros.listarVencidosOuProximos(ctx.pool, 7, 5),
    proximasReunioes(ctx),
    auditoria.recentes(ctx.pool, 40),
  ]);
  return {
    paraRevisar: paraRevisar.map(paraResumo),
    vencidos: vencidos.map(paraResumo),
    proximasReunioes: proximas,
    // Só eventos de conhecimento: login, tokens e afins ficam fora do início.
    atividade: atividade.filter((a) => a.acao in DESCRICAO_ACAO).slice(0, 8).map((a) => ({
      quando: a.criadoEm.toISOString(),
      descricao: `${a.usuario ?? (a.canal === "webhook" ? "Fathom" : "O cérebro")} ${DESCRICAO_ACAO[a.acao] ?? a.acao}${
        typeof a.detalhes.codigo === "string" ? ` ${a.detalhes.codigo}` : ""
      }`,
      registroId: a.entidadeId && /^[0-9a-f-]{36}$/.test(a.entidadeId) ? a.entidadeId : null,
    })),
  };
}

export async function saudeFila(ctx: Contexto) {
  return jobs.resumo(ctx.pool);
}

// ───────────────────────────── Lacunas ─────────────────────────────

/** Perguntas que o cérebro não soube responder: viram pauta de documentação. */
export async function listarLacunas(ctx: Contexto) {
  const linhas = await lacunas.listarAbertas(ctx.pool, 50);
  return linhas.map((l) => ({ ...l, criadoEm: l.criadoEm.toISOString() }));
}

export async function resolverLacuna(ctx: Contexto, ator: Ator, id: string, registroId: string | null) {
  await lacunas.resolver(ctx.pool, id, registroId);
  await auditar(ctx.pool, ator, "lacuna.resolvida", { entidade: "lacuna", id }, { registroId });
}
