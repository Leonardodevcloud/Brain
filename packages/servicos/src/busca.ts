import {
  STATUS_CONSULTAVEIS,
  type FonteDTO,
  type Pergunta,
  type RespostaPerguntaDTO,
  type StatusRegistro,
} from "@cerebro/core";
import { lacunas, registros, trechos, type FiltroBusca, type TrechoComVetor } from "@cerebro/db";
import {
  SISTEMA_RESPOSTA,
  cosseno,
  dividirEmTrechos,
  fusaoRRF,
  lerJson,
  mascarar,
  montarPerguntaComFontes,
  restaurar,
} from "@cerebro/ia";
import { auditar, type Ator, type Contexto } from "./contexto.js";

/** Similaridade mínima para um trecho contar como relevante na busca semântica. */
const LIMIAR_SEMANTICO = 0.55;
const MAX_FONTES = 6;

// Os vetores cabem em memória neste volume (milhares de trechos). Cache curto evita ler tudo a cada pergunta.
const CACHE_MS = 60_000;
const cacheVetores = new Map<string, { em: number; trechos: TrechoComVetor[] }>();

export function invalidarCacheBusca() {
  cacheVetores.clear();
}

async function vetoresDoFiltro(ctx: Contexto, filtro: FiltroBusca) {
  const chave = JSON.stringify(filtro);
  const emCache = cacheVetores.get(chave);
  if (emCache && ctx.agora().getTime() - emCache.em < CACHE_MS) return emCache.trechos;
  const lista = await trechos.listarComVetor(ctx.pool, filtro);
  cacheVetores.set(chave, { em: ctx.agora().getTime(), trechos: lista });
  return lista;
}

/**
 * Busca híbrida: texto completo em português + similaridade semântica,
 * fundidos por Reciprocal Rank Fusion. Devolve um trecho por registro.
 */
export async function buscar(ctx: Contexto, p: Pergunta & { incluirRestritos?: boolean }): Promise<FonteDTO[]> {
  const statusIn: StatusRegistro[] = p.incluirRascunhos ? [...STATUS_CONSULTAVEIS, "rascunho"] : STATUS_CONSULTAVEIS;
  const filtro: FiltroBusca = {
    statusIn,
    tipo: p.tipo,
    area: p.area,
    clienteRef: p.clienteRef,
    incluirRestritos: p.incluirRestritos ?? true,
  };

  const porTexto = await trechos.buscarTexto(ctx.pool, p.pergunta, filtro, 20);
  const melhorTrecho = new Map<string, { texto: string; similaridade: number }>();
  for (const t of porTexto) melhorTrecho.set(t.registroId, { texto: t.trecho, similaridade: 0 });

  let porVetor: string[] = [];
  if (ctx.embeddings) {
    try {
      const [consulta] = await ctx.embeddings.gerar([p.pergunta], "consulta");
      const candidatos = (await vetoresDoFiltro(ctx, filtro))
        .map((t) => ({ t, s: cosseno(consulta!, t.embedding) }))
        .filter((x) => x.s >= LIMIAR_SEMANTICO)
        .sort((a, b) => b.s - a.s);
      const vistos = new Set<string>();
      for (const { t, s } of candidatos) {
        if (vistos.has(t.registroId)) continue;
        vistos.add(t.registroId);
        porVetor.push(t.registroId);
        // O trecho semântico costuma ser melhor que o destaque textual.
        melhorTrecho.set(t.registroId, { texto: t.texto, similaridade: s });
        if (porVetor.length >= 20) break;
      }
    } catch (erro) {
      // Sem embeddings a busca continua só por texto.
      ctx.log.warn({ erro: (erro as Error).message }, "busca semântica indisponível");
      porVetor = [];
    }
  }

  const pontos = fusaoRRF([porTexto.map((t) => t.registroId), porVetor]);
  const ordenados = [...pontos.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FONTES);
  const linhas = await registros.buscarPorIds(
    ctx.pool,
    ordenados.map(([id]) => id),
  );
  const porId = new Map(linhas.map((l) => [l.id, l]));

  return ordenados.flatMap(([id, pontuacao], i) => {
    const r = porId.get(id);
    if (!r) return [];
    return [
      {
        indice: i + 1,
        registroId: r.id,
        codigo: r.codigo,
        titulo: r.titulo,
        tipo: r.tipo,
        status: r.status,
        versao: r.versao,
        revisarEm: r.revisarEm,
        trecho: melhorTrecho.get(id)?.texto ?? dividirEmTrechos(r.conteudo, 400)[0] ?? "",
        pontuacao: Number(pontuacao.toFixed(4)),
      },
    ];
  });
}

/**
 * Responde uma pergunta citando os registros. Sem base suficiente, a pergunta vira lacuna.
 * Restritos só entram na resposta se houver um provedor de IA seguro configurado.
 */
export async function responder(ctx: Contexto, ator: Ator, p: Pergunta): Promise<RespostaPerguntaDTO> {
  const fontes = await buscar(ctx, p);
  await auditar(ctx.pool, ator, "consulta.pergunta", undefined, { pergunta: p.pergunta, fontes: fontes.map((f) => f.codigo) });

  const avisos = fontes
    .filter((f) => f.status !== "vigente")
    .map((f) => (f.status === "revisar" ? `${f.codigo} está com a revisão vencida.` : `${f.codigo} ainda é um rascunho.`));

  if (fontes.length === 0) {
    await lacunas.registrar(ctx.pool, p.pergunta, ator.usuarioId, ator.canal);
    return { pergunta: p.pergunta, resposta: null, fontes, lacuna: true, avisos };
  }

  const restritas = new Set(
    (await registros.buscarPorIds(ctx.pool, fontes.map((f) => f.registroId)))
      .filter((r) => r.confidencialidade === "restrito")
      .map((r) => r.id),
  );
  const provedor = restritas.size > 0 ? ctx.iaRestrita : ctx.ia;
  if (!provedor) {
    if (restritas.size > 0 && ctx.ia) avisos.push("Há fontes restritas: a resposta automática fica desligada para elas.");
    return { pergunta: p.pergunta, resposta: null, fontes, lacuna: false, avisos };
  }

  const { texto, mapa } = mascarar(montarPerguntaComFontes(p.pergunta, fontes));
  try {
    const bruto = await provedor.gerar({
      sistema: SISTEMA_RESPOSTA,
      mensagens: [{ papel: "user", conteudo: texto }],
      json: true,
      temperatura: 0.1,
      maxTokens: 1200,
    });
    const { resposta, suficiente } = lerJson<{ resposta: string; suficiente: boolean }>(bruto);
    if (!suficiente) await lacunas.registrar(ctx.pool, p.pergunta, ator.usuarioId, ator.canal);
    return { pergunta: p.pergunta, resposta: restaurar(resposta, mapa), fontes, lacuna: !suficiente, avisos };
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "falha ao gerar resposta; devolvendo só as fontes");
    avisos.push("A resposta automática falhou agora. As fontes abaixo continuam valendo.");
    return { pergunta: p.pergunta, resposta: null, fontes, lacuna: false, avisos };
  }
}
