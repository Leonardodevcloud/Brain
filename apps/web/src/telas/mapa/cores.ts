import type { Area, TipoRegistro } from "@cerebro/core/publico";

/**
 * Mapa "Atlas neural": fundo quase preto e cada ÁREA com uma cor viva.
 * As áreas viram aglomerados coloridos (como os grupos do Obsidian); o tipo do registro
 * aparece no rótulo e no painel, não na cor.
 */
export const COR_AREA: Record<Area, string> = {
  operacoes: "#A78BFA",
  comercial: "#34D399",
  financeiro: "#FBBF24",
  atendimento: "#38BDF8",
  pessoas: "#F472B6",
  tecnologia: "#60A5FA",
  gestao: "#FB923C",
  marketing: "#E879F9",
};

/** Mantido para quem ainda mostra o tipo com cor (busca, etiquetas). */
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
  documento: "#FB923C",
};

export const COR_HUB = "#E2E8F0";
export const COR_CLIENTE = "#2DD4BF";
export const COR_REVISAR = "#F97316";
/** Destaque do selecionado e das ligações em foco. */
export const COR_HUD = "#E2E8F0";
export const COR_HUD_2 = "#A78BFA";
export const FUNDO_MAPA = "#05070C";
export const TEXTO_MAPA = "#F1F5F9";
export const BORDA_MAPA = "rgba(148,163,184,0.2)";

/** "#A78BFA" + 0.4 → "rgba(167,139,250,0.4)" */
export function comAlfa(hex: string, alfa: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alfa})`;
}
