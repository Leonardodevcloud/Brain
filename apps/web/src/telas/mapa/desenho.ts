import type { LigacaoMapaDTO, NoMapaDTO } from "@cerebro/core/publico";
import { COR_CLIENTE, COR_HUB, COR_HUD, COR_HUD_2, COR_REVISAR, COR_TIPO, FUNDO_MAPA, comAlfa } from "./cores";

/** Nó como a biblioteca do grafo o manipula: o DTO mais a posição da simulação. */
export type No = NoMapaDTO & { x?: number; y?: number; fx?: number; fy?: number };
export type Ligacao = Omit<LigacaoMapaDTO, "origem" | "destino"> & { origem: string | No; destino: string | No };

export const idDe = (p: string | No) => (typeof p === "string" ? p : p.id);

export function raio(no: No) {
  if (no.categoria === "area") return 8;
  if (no.categoria === "cliente") return 5.5;
  return 2.8 + Math.sqrt(no.grau) * 1.3;
}

export function corDoNo(no: No) {
  if (no.categoria === "area") return COR_HUB;
  if (no.categoria === "cliente") return COR_CLIENTE;
  return no.tipo ? COR_TIPO[no.tipo] : "#A8A29E";
}

export interface EstadoDesenho {
  /** Nós em destaque (o apontado/selecionado e os vizinhos). Vazio = nenhum destaque. */
  destaque: Set<string>;
  selecionado: string | null;
  /** Tempo em segundos, para os anéis girarem e os hubs respirarem. */
  tempo: number;
  movimento: boolean;
}

const ROTULO_MAX = 38;
const encurtar = (t: string) => (t.length > ROTULO_MAX ? `${t.slice(0, ROTULO_MAX - 1)}…` : t);
const MONO = '"Geist Mono Variable", ui-monospace, monospace';
const SANS = '"Geist Variable", system-ui, sans-serif';

/** Desenha um nó no canvas. Tamanhos de texto e traço são divididos pela escala para ficarem constantes na tela. */
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
  const px = (v: number) => v / escala; // medida fixa na tela

  ctx.save();
  ctx.globalAlpha = apagado ? 0.14 : no.status === "obsoleto" ? 0.35 : 1;

  if (no.categoria === "area") {
    // Hub: anel tracejado girando devagar, núcleo claro e nome em caixa alta.
    ctx.strokeStyle = comAlfa(cor, 0.3);
    ctx.lineWidth = px(1);
    ctx.setLineDash([px(2), px(4)]);
    ctx.lineDashOffset = -t * px(6);
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const halo = r * (2 + (e.movimento ? (Math.sin(t * 0.8) + 1) * 0.3 : 0.3));
    const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, halo);
    g.addColorStop(0, comAlfa(cor, 0.28));
    g.addColorStop(1, comAlfa(cor, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, halo, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    rotulo(ctx, no.rotulo.toLocaleUpperCase("pt-BR"), x, y - r * 2.4 - px(16), Math.max(px(11), 3), comAlfa(cor, 0.9), 500, MONO, px(1.6));
    ctx.restore();
    return;
  }

  // Brilho de quem está em destaque.
  if (selecionado || (emDestaque && comDestaque)) {
    const g = ctx.createRadialGradient(x, y, r * 0.4, x, y, r * 3.4);
    g.addColorStop(0, comAlfa(cor, selecionado ? 0.6 : 0.38));
    g.addColorStop(1, comAlfa(cor, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 3.4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (no.categoria === "cliente") {
    ctx.fillStyle = comAlfa(cor, 0.95);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
  } else if (no.status === "rascunho") {
    // Rascunho: só o contorno tracejado — ainda não vale.
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

  if (no.status === "revisar") {
    ctx.strokeStyle = COR_REVISAR;
    ctx.lineWidth = px(1.4);
    ctx.beginPath();
    ctx.arc(x, y, r + px(3), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (selecionado) mira(ctx, x, y, r, escala, t);

  // Rótulos: com zoom, ou para o que está em destaque.
  if (!apagado && (escala >= 2.2 || (emDestaque && comDestaque) || selecionado)) {
    ctx.globalAlpha = no.status === "obsoleto" ? 0.5 : 1;
    const texto = no.codigo && !selecionado ? `${no.codigo} · ${encurtar(no.rotulo)}` : encurtar(no.rotulo);
    const distancia = selecionado ? r + px(30) : r + px(5);
    rotulo(ctx, texto, x, y + distancia, px(selecionado ? 13 : 10.5), selecionado ? "#FFFFFF" : "#E2E8F0", selecionado ? 600 : 400, SANS);
  }
  ctx.restore();
}

/** Mira do HUD em volta do selecionado: anel fixo, arco girando, anel pontilhado ao contrário e cantos. */
function mira(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, escala: number, t: number) {
  const px = (v: number) => v / escala;
  const r1 = r + px(12);
  const r2 = r + px(17);
  const r3 = r + px(21);

  ctx.strokeStyle = comAlfa(COR_HUD, 0.35);
  ctx.lineWidth = px(1);
  ctx.beginPath();
  ctx.arc(x, y, r1, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = COR_HUD;
  ctx.lineWidth = px(2);
  const a = t * 1.1;
  ctx.beginPath();
  ctx.arc(x, y, r2, a, a + Math.PI * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r2, a + Math.PI, a + Math.PI * 1.25);
  ctx.stroke();

  ctx.strokeStyle = comAlfa(COR_HUD_2, 0.55);
  ctx.lineWidth = px(1);
  ctx.setLineDash([px(1.5), px(4)]);
  ctx.lineDashOffset = t * px(10);
  ctx.beginPath();
  ctx.arc(x, y, r3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Cantos da mira.
  const m = r3 + px(5);
  const l = px(7);
  ctx.strokeStyle = "#EDE9FE";
  ctx.lineWidth = px(1.4);
  ctx.beginPath();
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const cx = x + sx * m;
    const cy = y + sy * m;
    ctx.moveTo(cx - sx * l, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy - sy * l);
  }
  ctx.stroke();

  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.arc(x, y, Math.min(r * 0.4, px(3)), 0, Math.PI * 2);
  ctx.fill();
}

function rotulo(
  ctx: CanvasRenderingContext2D,
  texto: string,
  x: number,
  y: number,
  tamanho: number,
  cor: string,
  peso: number,
  fonte: string,
  espaco = 0,
) {
  ctx.font = `${peso} ${tamanho}px ${fonte}`;
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${espaco}px`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Contorno escuro para ler o texto sobre as linhas.
  ctx.lineWidth = tamanho * 0.34;
  ctx.strokeStyle = comAlfa(FUNDO_MAPA, 0.9);
  ctx.lineJoin = "round";
  ctx.strokeText(texto, x, y);
  ctx.fillStyle = cor;
  ctx.fillText(texto, x, y);
}

/** Área de clique um pouco maior que o desenho, para acertar nós pequenos no celular. */
export function areaDeClique(no: No, cor: string, ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = cor;
  ctx.beginPath();
  ctx.arc(no.x ?? 0, no.y ?? 0, raio(no) + 3, 0, Math.PI * 2);
  ctx.fill();
}

export function corDaLigacao(l: Ligacao, destaque: Set<string>, emDestaque: boolean): string {
  if (destaque.size > 0) {
    if (!emDestaque) return "rgba(148,163,184,0.03)";
    return comAlfa(COR_HUD, 0.8);
  }
  switch (l.tipo) {
    case "area":
      return "rgba(148,163,184,0.12)";
    case "cliente":
      return "rgba(52,211,153,0.18)";
    case "semelhante":
      return "rgba(167,139,250,0.22)";
    case "contradiz":
      return "rgba(251,113,133,0.6)";
    default:
      return "rgba(226,232,240,0.3)";
  }
}

export const ehRelacaoExplicita = (l: Ligacao) => l.tipo !== "area" && l.tipo !== "cliente" && l.tipo !== "semelhante";
