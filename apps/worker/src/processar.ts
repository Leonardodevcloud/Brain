import { jobs, type JobLinha } from "@cerebro/db";
import { JOB, fontes, indexarRegistro, invalidarCacheBusca, sincronizarRegrasDoCodigo, type Contexto, type TipoJob } from "@cerebro/servicos";

type Tratador = (ctx: Contexto, payload: Record<string, unknown>) => Promise<unknown>;

const texto = (v: unknown) => (typeof v === "string" ? v : "");

/** O que cada tipo de job faz. Todos são idempotentes: rodar duas vezes não duplica nada. */
export const TRATADORES: Record<TipoJob, Tratador> = {
  [JOB.indexarRegistro]: async (ctx, p) => {
    await indexarRegistro(ctx, texto(p.registroId));
    invalidarCacheBusca();
  },
  [JOB.gerarAta]: (ctx, p) => fontes.gerarAta(ctx, texto(p.reuniaoId)),
  [JOB.extrairConversaClaude]: (ctx, p) =>
    fontes.extrairConhecimento(ctx, {
      chave: `claude:${texto(p.id)}`,
      origem: "conversa",
      titulo: texto(p.titulo) || "Conversa sem título",
      texto: texto(p.texto),
      fonteUrl: `https://claude.ai/chat/${encodeURIComponent(texto(p.id))}`,
    }),
  [JOB.extrairEmail]: (ctx, p) =>
    fontes.extrairConhecimento(ctx, {
      chave: texto(p.chave),
      origem: "email",
      titulo: texto(p.assunto) || "E-mail sem assunto",
      texto: texto(p.texto),
      fonteUrl: null,
    }),
  [JOB.regrasCodigo]: async (ctx, p) => {
    const r = await sincronizarRegrasDoCodigo(ctx, { forcar: p.forcar === true });
    invalidarCacheBusca();
    return r;
  },
};

/** Reserva e executa um job. Devolve `false` quando a fila está vazia. */
export async function executarProximo(ctx: Contexto, tratadores: Record<string, Tratador> = TRATADORES): Promise<boolean> {
  const job: JobLinha | null = await jobs.reservar(ctx.pool);
  if (!job) return false;
  const inicio = Date.now();
  const tratador = tratadores[job.tipo];
  try {
    if (!tratador) throw new Error(`Tipo de job desconhecido: ${job.tipo}`);
    await tratador(ctx, job.payload);
    await jobs.concluir(ctx.pool, job.id);
    ctx.log.info({ job: job.id, tipo: job.tipo, ms: Date.now() - inicio }, "job concluído");
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    const definitivo = await jobs.falhar(ctx.pool, job, mensagem.slice(0, 2000));
    const nivel = definitivo ? "error" : "warn";
    ctx.log[nivel]({ job: job.id, tipo: job.tipo, tentativa: job.tentativas, erro: mensagem }, definitivo ? "job falhou de vez" : "job vai tentar de novo");
  }
  return true;
}
