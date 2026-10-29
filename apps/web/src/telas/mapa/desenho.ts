import type { LigacaoMapaDTO, NoMapaDTO } from "@cerebro/core/publico";
import { COR_AREA, COR_CLIENTE, COR_HUB, COR_REVISAR, FUNDO_MAPA, comAlfa } from "./cores";

/** Nó como a biblioteca do grafo o manipula: o DTO mais a posição da simulação. */
export type No = NoMapaDTO & { x?: number; y?: number; fx?: number; fy?: number };
export type Ligacao = Omit<LigacaoMapaDTO, "origem" | "destino"> & { origem: string | No; destino: string | No };

export const idDe = (p: string | No) => (typeof p === "string" ? p : p.id);
const noDe = (p: string | No) => (typeof p === "string" ? null : p);

export function raio(no: No) {
  if (no.categoria === "area") return 5;
  if (no.categoria === "cliente") return 4.5;
  return 2.4 + Math.sqrt(no.grau) * 1.35;
}

/** Cor do aglomerado: a da área (clientes têm a sua). */
export function corDoNo(no: No) {
  if (no.categoria === "cliente") return COR_CLIENTE;
  if (no.area) return COR_AREA[no.area];
  return "#94A3B8";
}

export interface EstadoDesenho {
  /** Nós em destaque (o apontado/selecionado e os vizinhos). Vazio = nenhum destaque. */
  destaque: Set<string>;
  selecionado: string | null;
  tempo: number;
  movimento: boolean;
  /** Quantos registros cada área tem (vai no rótulo do hub). */
  contagemArea: Map<string, number>;
}

const ROTULO_MAX = 38;
const encurtar = (t: string) => (t.length > ROTULO_MAX ? `${t.slice(0, ROTULO_MAX - 1)}…` : t);
const MONO = '"Geist Mono Variable", ui-monospace, monospace';
const SANS = '"Geist Variable", system-ui, sans-serif';

/** Desenha um nó. Tamanhos de texto e traço são divididos pela escala para ficarem constantes na tela. */
export function desenharNo(no: No, ctx: CanvasRenderingContext2D, escala: number, e: EstadoDesenho) {
  const x = no.x ?? 0;
  const y = no.y ?? 0;
  const r = raio(no);
  const cor = corDoNo(no);
  const comDestaque = e.destaque.size > 0;
  const emDestaque = e.destaque.has(no.id);
  const apagado = comDestaque && !emDestaque;
  const selecionado = e.selecionado === no.id;
  const t = e.movimento ? e.tempo : 0;
  const px = (v: number) => v / escala;

  ctx.save();
  ctx.globalAlpha = apagado ? 0.1 : no.status === "obsoleto" ? 0.35 : 1;

  if (no.categoria === "area") {
    // Hub da área: ponto claro, anel que pulsa devagar e o nome em caixa alta com a contagem.
    ctx.shadowColor = cor;
    ctx.shadowBlur = px(18);
    ctx.fillStyle = COR_HUB;
    ctx.beginPath();
    ctx.arc(x, y, px(4.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = comAlfa(cor, selecionado ? 0.9 : 0.55);
    ctx.lineWidth = px(1.2);
    ctx.beginPath();
    ctx.arc(x, y, px(10 + Math.sin(t * 1.3) * 1.6), 0, Math.PI * 2);
    ctx.stroke();
    const nome = no.rotulo.toLocaleUpperCase("pt-BR");
    const qtd = no.area ? e.contagemArea.get(no.area) : undefined;
    rotulo(ctx, nome, x, y + px(15), px(12.5), cor, 600, MONO, px(1.4));
    if (qtd !== undefined) rotulo(ctx, `${qtd} ${qtd === 1 ? "registro" : "registros"}`, x, y + px(31), px(10.5), "rgba(148,163,184,0.85)", 400, MONO, px(0.6));
    ctx.restore();
    return;
  }

  // Brilho do ponto (o efeito "constelação").
  ctx.shadowColor = cor;
  ctx.shadowBlur = px(selecionado ? 22 : emDestaque && comDestaque ? 14 : 8);

  if (no.categoria === "cliente") {
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  } else if (no.status === "rascunho") {
    // Rascunho: contorno tracejado — ainda não vale.
    ctx.fillStyle = FUNDO_MAPA;
    ctx.strokeStyle = cor;
    ctx.lineWidth = px(1.3);
    ctx.setLineDash([px(2.5), px(2)]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  if (no.status === "revisar") {
    ctx.strokeStyle = COR_REVISAR;
    ctx.lineWidth = px(1.4);
    ctx.beginPath();
    ctx.arc(x, y, r + px(3), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Tarefas abertas ligadas: pontinho âmbar no canto.
  if (no.tarefasAbertas > 0 && !apagado) {
    ctx.fillStyle = "#FCD34D";
    ctx.strokeStyle = FUNDO_MAPA;
    ctx.lineWidth = px(1.2);
    ctx.beginPath();
    ctx.arc(x + r * 0.8, y - r * 0.8, Math.max(px(2.6), r * 0.32), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (selecionado) {
    // Anel branco e um arco girando: "está aqui".
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = px(1.6);
    ctx.beginPath();
    ctx.arc(x, y, r + px(5), 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = comAlfa(cor, 0.9);
    ctx.lineWidth = px(2);
    const a = t * 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r + px(10), a, a + Math.PI * 0.6);
    ctx.stroke();
  }

  // Rótulos: com zoom, ou para o que está em destaque.
  if (!apagado && (escala >= 2.2 || (emDestaque && comDestaque) || selecionado)) {
    ctx.globalAlpha = no.status === "obsoleto" ? 0.5 : 1;
    const texto = no.codigo && !selecionado ? `${no.codigo} · ${encurtar(no.rotulo)}` : encurtar(no.rotulo);
    const distancia = selecionado ? r + px(14) : r + px(5);
    rotulo(ctx, texto, x, y + distancia, px(selecionado ? 13 : 10.5), selecionado ? "#FFFFFF" : "rgba(226,232,240,0.88)", selecionado ? 600 : 400, SANS);
  }
  ctx.restore();
}

function rotulo(ctx: CanvasRenderingContext2D, texto: string, x: number, y: number, tamanho: number, cor: string, peso: number, fonte: string, espaco = 0) {
  ctx.font = `${peso} ${tamanho}px ${fonte}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${espaco}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = tamanho * 0.36;
  ctx.strokeStyle = comAlfa(FUNDO_MAPA, 0.88);
  ctx.lineJoin = "round";
  ctx.strokeText(texto, x, y);
  ctx.fillStyle = cor;
  ctx.fillText(texto, x, y);
}

/** Área de clique um pouco maior que o desenho, para acertar nós pequenos no celular. */
export function areaDeClique(no: No, cor: string, ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.arc(no.x ?? 0, no.y ?? 0, raio(no) + (no.categoria === "area" ? 8 : 3), 0, Math.PI * 2);
  ctx.fill();
}

/** Ligações coloridas pela área de onde saem; as que cruzam áreas ficam curvas (ver Mapa). */
export function corDaLigacao(l: Ligacao, destaque: Set<string>, emDestaque: boolean): string {
  const a = noDe(l.origem);
  const b = noDe(l.destino);
  const base = (b && b.categoria !== "area" ? corDoNo(b) : a ? corDoNo(a) : "#94A3B8") ?? "#94A3B8";
  if (destaque.size > 0) return emDestaque ? comAlfa(base, 0.95) : "rgba(148,163,184,0.025)";
  switch (l.tipo) {
    case "area":
      return comAlfa(base, 0.16);
    case "semelhante":
      return comAlfa(base, 0.2);
    case "contradiz":
      return "rgba(251,113,133,0.7)";
    default:
      return comAlfa(base, 0.32);
  }
}

export const ehRelacaoExplicita = (l: Ligacao) => l.tipo !== "area" && l.tipo !== "cliente" && l.tipo !== "semelhante";

/** Ligação entre áreas diferentes (fica curva, como no atlas). */
export function cruzaAreas(l: Ligacao) {
  const a = noDe(l.origem);
  const b = noDe(l.destino);
  return Boolean(a && b && a.categoria !== "area" && b.categoria !== "area" && a.area && b.area && a.area !== b.area);
}
