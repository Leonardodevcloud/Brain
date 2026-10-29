/**
 * Conversas com o Argos (lista da tela Perguntar). Cada pessoa vê só as suas;
 * a interface grava a conversa inteira depois de cada troca.
 */
import { AppError, type ConversaDTO, type ResumoConversaDTO, type TurnoSalvoDTO } from "@cerebro/core";
import { conversas as repo } from "@cerebro/db";
import type { Ator, Contexto } from "./contexto.js";

const MAX_TURNOS = 60;
const MAX_BYTES = 2_000_000;

function dono(ator: Ator) {
  if (!ator.usuarioId) throw AppError.semPermissao();
  return ator.usuarioId;
}

const resumo = (c: { id: string; titulo: string; trocas: number; atualizadoEm: Date }): ResumoConversaDTO => ({
  id: c.id,
  titulo: c.titulo,
  trocas: Number(c.trocas),
  atualizadoEm: new Date(c.atualizadoEm).toISOString(),
});

export async function listarConversas(ctx: Contexto, ator: Ator, busca?: string): Promise<ResumoConversaDTO[]> {
  return (await repo.listar(ctx.pool, dono(ator), busca)).map(resumo);
}

export async function obterConversa(ctx: Contexto, ator: Ator, id: string): Promise<ConversaDTO> {
  const c = await repo.buscar(ctx.pool, dono(ator), id);
  if (!c) throw AppError.naoEncontrado("A conversa");
  return { ...resumo(c), turnos: c.turnos as TurnoSalvoDTO[] };
}

/** Título = a primeira pergunta, encurtada. */
function tituloDe(turnos: TurnoSalvoDTO[]) {
  const primeira = turnos.find((t) => t.pergunta?.trim())?.pergunta.trim() ?? "Conversa";
  const limpa = primeira.replace(/\s+/g, " ").replace(/\s*\[áudio pouco claro\]\s*$/i, "");
  return limpa.length > 70 ? `${limpa.slice(0, 69).trimEnd()}…` : limpa;
}

export async function gravarConversa(ctx: Contexto, ator: Ator, id: string, turnos: TurnoSalvoDTO[]): Promise<ResumoConversaDTO> {
  const usuario = dono(ator);
  const lista = turnos.filter((t) => t && typeof t.pergunta === "string" && (t.resposta || t.erro)).slice(-MAX_TURNOS);
  if (!lista.length) throw AppError.requisicaoInvalida("A conversa está vazia.");
  if (JSON.stringify(lista).length > MAX_BYTES) throw AppError.requisicaoInvalida("A conversa ficou grande demais. Comece uma nova.");
  const texto = lista.map((t) => `${t.pergunta}\n${t.resposta?.fala ?? ""}`).join("\n").slice(0, 200_000);
  const ok = await repo.gravar(ctx.pool, usuario, { id, titulo: tituloDe(lista), turnos: lista, texto });
  if (!ok) throw AppError.semPermissao("Essa conversa é de outra pessoa.");
  return resumo((await repo.buscar(ctx.pool, usuario, id))!);
}

export async function apagarConversa(ctx: Contexto, ator: Ator, id: string) {
  if (!(await repo.apagar(ctx.pool, dono(ator), id))) throw AppError.naoEncontrado("A conversa");
}
