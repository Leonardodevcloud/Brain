import { AppError, type CaixaEmailDTO, type EmailDTO } from "@cerebro/core";
import { emails, emTransacao, integracoes, type EmailLinha } from "@cerebro/db";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { criarRegistroEm } from "./registros.js";
import { criarTarefa } from "./tarefas.js";

export type FiltroEmail = "todos" | "pendentes" | "registro" | "ignorados";

function situacao(e: EmailLinha, comIa: boolean): EmailDTO["situacao"] {
  if (e.acao === "ignorado") return "ignorado";
  if (e.acao === "tarefa") return "tarefa";
  if (e.acao === "registro" || e.resultadoIa === "registro") return "registro";
  if (e.resultadoIa === "irrelevante") return "irrelevante";
  if (e.resultadoIa === "erro" || !comIa) return "novo";
  return "analisando";
}

function paraDto(e: EmailLinha, comIa: boolean): EmailDTO {
  const s = situacao(e, comIa);
  return {
    id: e.id,
    remetente: e.remetente,
    assunto: e.assunto || "(sem assunto)",
    recebidoEm: e.recebidoEm.toISOString(),
    trecho: e.trecho,
    situacao: s,
    pendente: s === "novo" || s === "analisando" || (s === "registro" && e.registroStatus === "rascunho" && e.acao === null),
    registro: e.registroId ? { id: e.registroId, codigo: e.registroCodigo!, titulo: e.registroTitulo!, status: e.registroStatus! } : null,
    tarefa: e.tarefaCodigo ? { codigo: e.tarefaCodigo, titulo: e.tarefaTitulo!, status: e.tarefaStatus! } : null,
  };
}

function exigirPessoa(ator: Ator) {
  if (!ator.usuarioId) throw AppError.semPermissao("Só pessoas mexem na caixa de e-mail.");
}

async function exigirEmail(ctx: Contexto, id: string) {
  const e = /^[0-9a-f-]{36}$/i.test(id) ? await emails.buscar(ctx.pool, id) : null;
  if (!e) throw AppError.naoEncontrado("E-mail não encontrado.");
  return e;
}

export async function listarEmails(ctx: Contexto, filtroBruto: unknown): Promise<CaixaEmailDTO> {
  const filtro: FiltroEmail = ["pendentes", "registro", "ignorados"].includes(String(filtroBruto)) ? (filtroBruto as FiltroEmail) : "todos";
  const [linhas, pendentes, salvo] = await Promise.all([
    emails.listar(ctx.pool, filtro),
    emails.contarPendentes(ctx.pool),
    integracoes.obter(ctx.pool, "email"),
  ]);
  const ultima = salvo?.config.ultimaLeituraEm;
  return {
    caixa: ctx.imap?.usuario ?? null,
    ultimaLeituraEm: typeof ultima === "string" ? ultima : null,
    pendentes,
    emails: linhas.map((e) => paraDto(e, Boolean(ctx.ia))),
  };
}

export const contarPendentes = (ctx: Contexto) => emails.contarPendentes(ctx.pool);

export async function ignorarEmail(ctx: Contexto, ator: Ator, id: string, desfazer = false) {
  exigirPessoa(ator);
  const e = await exigirEmail(ctx, id);
  await emails.decidir(ctx.pool, e.id, desfazer ? null : "ignorado", ator.usuarioId);
  await auditar(ctx.pool, ator, desfazer ? "email.restaurado" : "email.ignorado", undefined, { assunto: e.assunto.slice(0, 120) });
  return paraDto((await emails.buscar(ctx.pool, e.id))!, Boolean(ctx.ia));
}

/** O e-mail vira uma tarefa (assunto = título; remetente e texto na descrição). */
export async function emailParaTarefa(ctx: Contexto, ator: Ator, id: string) {
  exigirPessoa(ator);
  const e = await exigirEmail(ctx, id);
  if (e.tarefaId) return paraDto(e, Boolean(ctx.ia));
  const data = e.recebidoEm.toLocaleString("pt-BR", { timeZone: "America/Bahia", dateStyle: "short", timeStyle: "short" });
  const t = await criarTarefa(
    ctx,
    ator,
    {
      titulo: (e.assunto || `E-mail de ${e.remetente}`).slice(0, 300),
      descricao: `E-mail de ${e.remetente} em ${data}:\n\n${e.texto.slice(0, 3000)}`,
    },
    { origem: "email" },
  );
  await emails.decidir(ctx.pool, e.id, "tarefa", ator.usuarioId, { tarefaId: t.id });
  return paraDto((await emails.buscar(ctx.pool, e.id))!, Boolean(ctx.ia));
}

/** Quando a IA achou irrelevante (ou está desligada), a pessoa transforma em rascunho para revisar. */
export async function emailParaRegistro(ctx: Contexto, ator: Ator, id: string) {
  exigirPessoa(ator);
  const e = await exigirEmail(ctx, id);
  if (e.registroId) return paraDto(e, Boolean(ctx.ia));
  const registroId = await emTransacao(ctx.pool, (db) =>
    criarRegistroEm(
      db,
      ctx,
      ator,
      {
        tipo: "nota",
        titulo: (e.assunto || `E-mail de ${e.remetente}`).slice(0, 200),
        conteudo: `${e.texto.slice(0, 50_000)}\n\n_Origem: e-mail de ${e.remetente}_`,
        area: "gestao",
        empresa: "todas",
        confidencialidade: "interno",
        fonteUrl: null,
        dados: { origemExternaId: `${e.chave}:manual` },
        publicar: false,
        relacoes: [],
      },
      { origem: "email", sempreRascunho: true },
    ),
  );
  await emails.decidir(ctx.pool, e.id, "registro", ator.usuarioId, { registroId });
  return paraDto((await emails.buscar(ctx.pool, e.id))!, Boolean(ctx.ia));
}
