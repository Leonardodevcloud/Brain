import type { TipoRegistro } from "@cerebro/core/publico";

/**
 * Cor de cada tipo de registro no fundo escuro do mapa (estilo HUD).
 * Tons de brilho parecido, mas com claridades diferentes para não depender só do matiz.
 */
export const COR_TIPO: Record<TipoRegistro, string> = {
  pop: "#A78BFA",
  decisao: "#22D3EE",
  politica: "#FCD34D",
  cliente: "#34D399",
  reuniao: "#F472B6",
  nota: "#94A3B8",
  ocorrencia: "#FB7185",
  sistema: "#60A5FA",
  indicador: "#A3E635",
};

/** Hubs de área: claros e neutros, para os registros coloridos se destacarem em volta. */
export const COR_HUB = "#E2E8F0";
export const COR_CLIENTE = "#34D399";
export const COR_REVISAR = "#FB923C";
/** Destaque do HUD (anéis do selecionado, partículas). */
export const COR_HUD = "#A78BFA";
export const COR_HUD_2 = "#22D3EE";
export const FUNDO_MAPA = "#05060B";

/** "#A78BFA" + 0.4 → "rgba(167,139,250,0.4)" */
export function comAlfa(hex: string, alfa: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alfa})`;
}
