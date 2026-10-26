import { NOME_AREA, type LigacaoMapaDTO, type MapaDTO, type NoMapaDTO } from "@cerebro/core";
import { mapa as repo } from "@cerebro/db";
import { cosseno, mediaVetores, normalizar, vetoresTfIdf, cossenoEsparso, vizinhosMaisProximos } from "@cerebro/ia";
import type { Contexto } from "./contexto.js";

// Limiares calibrados para ligar só o que é parecido de verdade.
const LIMIAR_EMBEDDINGS = 0.78;
const LIMIAR_TEXTO = 0.22;
const VIZINHOS_POR_NO = 3;
const VALIDADE_CACHE_MS = 15_000;

let cache: { em: number; dados: MapaDTO } | null = null;

export function invalidarCacheMapa() {
  cache = null;
}

const chaveCliente = (nome: string) =>
  `cliente:${nome
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")}`;

/**
 * Monta o grafo de conhecimento: registros ligados à sua área, ao cliente, às relações
 * explícitas (substitui, implementa…) e aos registros mais parecidos em conteúdo.
 */
export async function montarMapa(ctx: Contexto): Promise<MapaDTO> {
  if (cache && ctx.agora().getTime() - cache.em < VALIDADE_CACHE_MS) return cache.dados;

  const [linhas, relacoes, vetores] = await Promise.all([repo.nos(ctx.pool), repo.relacoes(ctx.pool), repo.vetores(ctx.pool)]);

  const nos = new Map<string, NoMapaDTO>();
  const ligacoes: LigacaoMapaDTO[] = [];
  const grau = new Map<string, number>();
  const somar = (id: string) => grau.set(id, (grau.get(id) ?? 0) + 1);

  // Uma ficha de cliente (tipo "cliente") é o próprio ponto de encontro daquele cliente.
  const fichaDoCliente = new Map<string, string>();
  for (const r of linhas) if (r.tipo === "cliente" && r.clienteRef) fichaDoCliente.set(chaveCliente(r.clienteRef), r.id);

  for (const r of linhas) {
    nos.set(r.id, {
      id: r.id,
      categoria: "registro",
      rotulo: r.titulo,
      codigo: r.codigo,
      tipo: r.tipo,
      area: r.area,
      status: r.status,
      restrito: r.confidencialidade === "restrito",
      grau: 0,
      atualizadoEm: r.atualizadoEm.toISOString(),
    });

    const idArea = `area:${r.area}`;
    if (!nos.has(idArea)) {
      nos.set(idArea, { id: idArea, categoria: "area", rotulo: NOME_AREA[r.area], codigo: null, tipo: null, area: r.area, status: null, restrito: false, grau: 0, atualizadoEm: null });
    }
    ligacoes.push({ origem: r.id, destino: idArea, tipo: "area", peso: null });
    somar(idArea);

    if (r.clienteRef) {
      const ficha = fichaDoCliente.get(chaveCliente(r.clienteRef));
      if (ficha) {
        if (ficha !== r.id) {
          ligacoes.push({ origem: r.id, destino: ficha, tipo: "cliente", peso: null });
          somar(r.id);
          somar(ficha);
        }
        continue;
      }
      const idCliente = chaveCliente(r.clienteRef);
      if (!nos.has(idCliente)) {
        nos.set(idCliente, { id: idCliente, categoria: "cliente", rotulo: r.clienteRef.trim(), codigo: null, tipo: null, area: null, status: null, restrito: false, grau: 0, atualizadoEm: null });
      }
      ligacoes.push({ origem: r.id, destino: idCliente, tipo: "cliente", peso: null });
      somar(r.id);
      somar(idCliente);
    }
  }

  const ligados = new Set<string>();
  for (const rel of relacoes) {
    if (!nos.has(rel.origemId) || !nos.has(rel.destinoId)) continue;
    ligacoes.push({ origem: rel.origemId, destino: rel.destinoId, tipo: rel.tipo, peso: null });
    ligados.add(`${rel.origemId}|${rel.destinoId}`).add(`${rel.destinoId}|${rel.origemId}`);
    somar(rel.origemId);
    somar(rel.destinoId);
  }

  // Semelhança: por sentido (média dos embeddings de cada registro) ou, sem eles, por palavras.
  const porRegistro = new Map<string, number[][]>();
  for (const v of vetores) porRegistro.set(v.registroId, [...(porRegistro.get(v.registroId) ?? []), v.embedding]);
  const comVetor = linhas.filter((r) => porRegistro.has(r.id));
  const usarEmbeddings = linhas.length > 1 && comVetor.length >= linhas.length * 0.6;

  let semelhanca: MapaDTO["semelhanca"] = "desligada";
  let pares: { a: string; b: string; peso: number }[] = [];
  if (usarEmbeddings) {
    semelhanca = "embeddings";
    const medias = comVetor.map((r) => normalizar(mediaVetores(porRegistro.get(r.id)!)));
    pares = vizinhosMaisProximos(comVetor.length, (i, j) => cosseno(medias[i]!, medias[j]!), {
      porItem: VIZINHOS_POR_NO,
      limiar: LIMIAR_EMBEDDINGS,
    }).map((p) => ({ a: comVetor[p.a]!.id, b: comVetor[p.b]!.id, peso: p.peso }));
  } else if (linhas.length > 1) {
    semelhanca = "texto";
    const tfidf = vetoresTfIdf(linhas.map((r) => `${r.titulo} ${r.titulo} ${r.clienteRef ?? ""} ${r.amostra}`));
    pares = vizinhosMaisProximos(linhas.length, (i, j) => cossenoEsparso(tfidf[i]!, tfidf[j]!), {
      porItem: VIZINHOS_POR_NO,
      limiar: LIMIAR_TEXTO,
    }).map((p) => ({ a: linhas[p.a]!.id, b: linhas[p.b]!.id, peso: p.peso }));
  }
  for (const p of pares) {
    if (ligados.has(`${p.a}|${p.b}`)) continue; // já existe uma relação explícita
    ligacoes.push({ origem: p.a, destino: p.b, tipo: "semelhante", peso: Math.round(p.peso * 100) / 100 });
    somar(p.a);
    somar(p.b);
  }

  for (const [id, g] of grau) {
    const no = nos.get(id);
    if (no) no.grau = g;
  }

  const dados: MapaDTO = { nos: [...nos.values()], ligacoes, semelhanca, geradoEm: ctx.agora().toISOString() };
  cache = { em: ctx.agora().getTime(), dados };
  return dados;
}
