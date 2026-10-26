import type { TipoRegistro } from "@cerebro/core/publico";

/**
 * Cor de cada tipo de registro no mapa claro.
 * Tons firmes (lidos sobre branco), com claridades diferentes para não depender só do matiz.
 */
export const COR_TIPO: Record<TipoRegistro, string> = {
  pop: "#7C3AED",
  decisao: "#0891B2",
  politica: "#D97706",
  cliente: "#059669",
  reuniao: "#DB2777",
  nota: "#78716C",
  ocorrencia: "#E11D48",
  sistema: "#2563EB",
  indicador: "#65A30D",
  documento: "#EA580C",
};

/** Áreas viram etiquetas neutras; os registros coloridos se destacam em volta. */
export const COR_HUB = "#57534E";
export const COR_CLIENTE = "#059669";
export const COR_REVISAR = "#F97316";
/** Destaque do selecionado e das ligações em foco. */
export const COR_HUD = "#7C3AED";
export const COR_HUD_2 = "#A78BFA";
export const FUNDO_MAPA = "#FAFAF9";
export const TEXTO_MAPA = "#1C1917";
export const BORDA_MAPA = "#E7E5E4";

/** "#A78BFA" + 0.4 → "rgba(167,139,250,0.4)" */
export function comAlfa(hex: string, alfa: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alfa})`;
}
