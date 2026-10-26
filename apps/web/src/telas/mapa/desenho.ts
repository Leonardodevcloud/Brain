import type { LigacaoMapaDTO, NoMapaDTO } from "@cerebro/core/publico";
import { BORDA_MAPA, COR_CLIENTE, COR_HUB, COR_HUD, COR_REVISAR, COR_TIPO, FUNDO_MAPA, TEXTO_MAPA, comAlfa } from "./cores";

/** Nó como a biblioteca do grafo o manipula: o DTO mais a posição da simulação. */
export type No = NoMapaDTO & { x?: number; y?: number; fx?: number; fy?: number };
export type Ligacao = Omit<LigacaoMapaDTO, "origem" | "destino"> & { origem: string | No; destino: string | No };

export const idDe = (p: string | No) => (typeof p === "string" ? p : p.id);

export function raio(no: No) {
  if (no.categoria === "area") return 8;
  if (no.categoria === "cliente") return 5;
  return 2.8 + Math.sqrt(no.grau) * 1.25;
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
  tempo: number;
  movimento: boolean;
}

const ROTULO_MAX = 38;
const encurtar = (t: string) => (t.length > ROTULO_MAX ? `${t.slice(0, ROTULO_MAX - 1)}…` : t);
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
  const px = (v: number) => v / escala; // medida fixa na tela

  ctx.save();
  ctx.globalAlpha = apagado ? 0.22 : no.status === "obsoleto" ? 0.4 : 1;

  if (no.categoria === "area") {
    // Área: etiqueta branca com borda fina, como no resto do app.
    const tamanho = px(12);
    ctx.font = `500 ${tamanho}px ${SANS}`;
    const texto = no.rotulo;
    const largura = ctx.measureText(texto).width + px(22);
    const altura = px(24);
    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = selecionado ? COR_HUD : BORDA_MAPA;
    ctx.lineWidth = px(selecionado ? 1.6 : 1);
    ctx.beginPath();
    ctx.roundRect(x - largura / 2, y - altura / 2, largura, altura, altura / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = selecionado ? COR_HUD : "#44403C";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(texto, x, y + px(0.5));
    ctx.restore();
    return;
  }

  // Selecionado: um halo suave e um anel simples.
  if (selecionado) {
    ctx.fillStyle = comAlfa(cor, 0.14);
    ctx.beginPath();
    ctx.arc(x, y, r + px(10), 0, Math.PI * 2);
    ctx.fill();
  }

  if (no.categoria === "cliente") {
    ctx.fillStyle = cor;
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = px(1.4);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (no.status === "rascunho") {
    // Rascunho: só o contorno tracejado — ainda não vale.
    ctx.fillStyle = FUNDO_MAPA;
    ctx.strokeStyle = cor;
    ctx.lineWidth = px(1.4);
    ctx.setLineDash([px(2.5), px(2)]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = cor;
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = px(1.4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (no.status === "revisar") {
    ctx.strokeStyle = COR_REVISAR;
    ctx.lineWidth = px(1.4);
    ctx.beginPath();
    ctx.arc(x, y, r + px(3), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Tarefas abertas ligadas: um pontinho âmbar no canto do nó.
  if (no.tarefasAbertas > 0 && !apagado) {
    ctx.fillStyle = "#F59E0B";
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = px(1.2);
    ctx.beginPath();
    ctx.arc(x + r * 0.8, y - r * 0.8, Math.max(px(2.6), r * 0.32), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (selecionado) {
    ctx.strokeStyle = COR_HUD;
    ctx.lineWidth = px(2);
    ctx.beginPath();
    ctx.arc(x, y, r + px(5), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rótulos: com zoom, ou para o que está em destaque.
  if (!apagado && (escala >= 2.2 || (emDestaque && comDestaque) || selecionado)) {
    ctx.globalAlpha = no.status === "obsoleto" ? 0.5 : 1;
    const texto = no.codigo && !selecionado ? `${no.codigo} · ${encurtar(no.rotulo)}` : encurtar(no.rotulo);
    const distancia = selecionado ? r + px(10) : r + px(5);
    rotulo(ctx, texto, x, y + distancia, px(selecionado ? 12.5 : 11), selecionado ? TEXTO_MAPA : "#44403C", selecionado ? 600 : 400);
  }
  ctx.restore();
}

function rotulo(ctx: CanvasRenderingContext2D, texto: string, x: number, y: number, tamanho: number, cor: string, peso: number) {
  ctx.font = `${peso} ${tamanho}px ${SANS}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Contorno do fundo para ler o texto sobre as linhas.
  ctx.lineWidth = tamanho * 0.4;
  ctx.strokeStyle = comAlfa(FUNDO_MAPA, 0.92);
  ctx.lineJoin = "round";
  ctx.strokeText(texto, x, y);
  ctx.fillStyle = cor;
  ctx.fillText(texto, x, y);
}

/** Área de clique um pouco maior que o desenho, para acertar nós pequenos no celular. */
export function areaDeClique(no: No, cor: string, ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = cor;
  ctx.beginPath();
  if (no.categoria === "area") {
    // A etiqueta é mais larga que alta.
    ctx.roundRect((no.x ?? 0) - 34, (no.y ?? 0) - 10, 68, 20, 10);
  } else {
    ctx.arc(no.x ?? 0, no.y ?? 0, raio(no) + 3, 0, Math.PI * 2);
  }
  ctx.fill();
}

export function corDaLigacao(l: Ligacao, destaque: Set<string>, emDestaque: boolean): string {
  if (destaque.size > 0) {
    if (!emDestaque) return "rgba(120,113,108,0.05)";
    return comAlfa(COR_HUD, 0.6);
  }
  switch (l.tipo) {
    case "area":
      return "rgba(120,113,108,0.14)";
    case "cliente":
      return "rgba(5,150,105,0.22)";
    case "semelhante":
      return "rgba(124,58,237,0.2)";
    case "contradiz":
      return "rgba(225,29,72,0.55)";
    default:
      return "rgba(68,64,60,0.28)";
  }
}

export const ehRelacaoExplicita = (l: Ligacao) => l.tipo !== "area" && l.tipo !== "cliente" && l.tipo !== "semelhante";
