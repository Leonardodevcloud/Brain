import type { LigacaoMapaDTO, NoMapaDTO } from "@cerebro/core/publico";
import { COR_AREA, COR_CLIENTE, COR_REVISAR, FUNDO_MAPA, comAlfa } from "./cores";

/** Nó como a biblioteca do grafo o manipula: o DTO mais a posição da simulação. */
export type No = NoMapaDTO & { x?: number; y?: number; fx?: number; fy?: number };
export type Ligacao = Omit<LigacaoMapaDTO, "origem" | "destino"> & { origem: string | No; destino: string | No };

export const idDe = (p: string | No) => (typeof p === "string" ? p : p.id);

export function raio(no: No) {
  if (no.categoria === "area") return 9;
  if (no.categoria === "cliente") return 5.5;
  return 2.6 + Math.sqrt(no.grau) * 1.35;
}

export function corDoNo(no: No) {
  if (no.categoria === "cliente") return COR_CLIENTE;
  return no.area ? COR_AREA[no.area] : "#A8A29E";
}

export interface EstadoDesenho {
  /** Nós em destaque (o apontado/selecionado e os vizinhos). Vazio = nenhum destaque. */
  destaque: Set<string>;
  selecionado: string | null;
  /** 0–1, oscila devagar para o brilho das áreas "respirar". */
  pulso: number;
  movimento: boolean;
}

const ROTULO_MAX = 38;
const encurtar = (t: string) => (t.length > ROTULO_MAX ? `${t.slice(0, ROTULO_MAX - 1)}…` : t);

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
  const alfa = apagado ? 0.12 : no.status === "obsoleto" ? 0.35 : 1;

  ctx.save();
  ctx.globalAlpha = alfa;

  if (no.categoria === "area") {
    // Halo que respira devagar.
    const halo = r * (2.6 + (e.movimento ? e.pulso * 0.6 : 0.3));
    const g = ctx.createRadialGradient(x, y, r * 0.6, x, y, halo);
    g.addColorStop(0, comAlfa(cor, 0.35));
    g.addColorStop(1, comAlfa(cor, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, halo, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = FUNDO_MAPA;
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cor;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.38, 0, Math.PI * 2);
    ctx.fill();

    rotulo(ctx, no.rotulo, x, y + r + 4, Math.max(12 / escala, 3.2), cor, 600);
    ctx.restore();
    return;
  }

  if (no.categoria === "cliente") {
    ctx.fillStyle = comAlfa(cor, 0.9);
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fill();
    if (escala > 1.2 || emDestaque) rotulo(ctx, no.rotulo, x, y + r + 2, 10 / escala, "#E7E5E4", 500);
    ctx.restore();
    return;
  }

  // Registro.
  if (selecionado || (emDestaque && comDestaque)) {
    const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 3.2);
    g.addColorStop(0, comAlfa(cor, selecionado ? 0.55 : 0.3));
    g.addColorStop(1, comAlfa(cor, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
  }

  if (no.status === "rascunho") {
    // Rascunho: só o contorno tracejado — ainda não vale.
    ctx.fillStyle = FUNDO_MAPA;
    ctx.strokeStyle = cor;
    ctx.lineWidth = 1.2 / Math.max(escala, 0.6);
    ctx.setLineDash([2 / escala, 1.6 / escala]);
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
    ctx.lineWidth = 1.4 / Math.max(escala, 0.6);
    ctx.beginPath();
    ctx.arc(x, y, r + 2.2 / Math.max(escala, 0.8), 0, Math.PI * 2);
    ctx.stroke();
  }

  if (selecionado) {
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1.6 / escala;
    ctx.beginPath();
    ctx.arc(x, y, r + 3 / escala, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Rótulos: com zoom, ou para o que está em destaque.
  if (!apagado && (escala >= 2.4 || (emDestaque && comDestaque) || selecionado)) {
    ctx.globalAlpha = no.status === "obsoleto" ? 0.5 : 1;
    rotulo(ctx, encurtar(no.rotulo), x, y + r + 2 / escala, 10.5 / escala, "#D6D3D1", selecionado ? 600 : 400);
  }
  ctx.restore();
}

function rotulo(ctx: CanvasRenderingContext2D, texto: string, x: number, y: number, tamanho: number, cor: string, peso: number) {
  ctx.font = `${peso} ${tamanho}px "Geist Variable", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // Contorno escuro para ler o texto sobre as linhas.
  ctx.lineWidth = tamanho * 0.32;
  ctx.strokeStyle = comAlfa(FUNDO_MAPA, 0.85);
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
    if (!emDestaque) return "rgba(255,255,255,0.025)";
    const origem = typeof l.origem === "string" ? null : l.origem;
    return origem ? comAlfa(corDoNo(origem), 0.75) : "rgba(255,255,255,0.6)";
  }
  switch (l.tipo) {
    case "area":
      return "rgba(255,255,255,0.07)";
    case "cliente":
      return "rgba(231,229,228,0.16)";
    case "semelhante":
      return "rgba(167,139,250,0.2)";
    case "contradiz":
      return "rgba(251,113,133,0.55)";
    default:
      return "rgba(255,255,255,0.32)";
  }
}

export const ehRelacaoExplicita = (l: Ligacao) => l.tipo !== "area" && l.tipo !== "cliente" && l.tipo !== "semelhante";
