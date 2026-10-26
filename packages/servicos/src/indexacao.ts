import { registros, trechos } from "@cerebro/db";
import { dividirEmTrechos } from "@cerebro/ia";
import { invalidarCacheBusca } from "./busca.js";
import type { Contexto } from "./contexto.js";

/**
 * Divide o registro em trechos e gera os vetores. Sem provedor de embeddings,
 * guarda os trechos sem vetor (a busca textual continua funcionando).
 */
export async function indexarRegistro(ctx: Contexto, registroId: string) {
  const r = await registros.buscarPorId(ctx.pool, registroId);
  if (!r) return { trechos: 0 };
  if (r.status === "descartado") {
    await trechos.substituir(ctx.pool, registroId, [], null);
    return { trechos: 0 };
  }

  // O título e o cliente entram em cada trecho: o vetor fica com o contexto do registro.
  const cabecalho = `${r.codigo} · ${r.titulo}${r.clienteRef ? ` · cliente ${r.clienteRef}` : ""}`;
  const partes = dividirEmTrechos(r.conteudo).map((t) => `${cabecalho}\n\n${t}`);
  const vetores = ctx.embeddings ? await ctx.embeddings.gerar(partes, "documento") : null;

  await trechos.substituir(
    ctx.pool,
    registroId,
    partes.map((texto, i) => ({ texto, embedding: vetores?.[i] ?? null })),
    ctx.embeddings?.modelo ?? null,
  );
  invalidarCacheBusca();
  return { trechos: partes.length, comVetor: Boolean(vetores) };
}
