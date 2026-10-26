import type { Area } from "@cerebro/core/publico";

/** Cor de cada área no fundo escuro do mapa. Escolhidas para se distinguirem entre si e do âmbar de "revisar". */
export const COR_AREA: Record<Area, string> = {
  operacoes: "#A78BFA",
  financeiro: "#34D399",
  comercial: "#60A5FA",
  tecnologia: "#22D3EE",
  pessoas: "#F472B6",
  marketing: "#FB923C",
  gestao: "#A3E635",
  atendimento: "#FB7185",
};

export const COR_CLIENTE = "#E7E5E4";
export const COR_REVISAR = "#FBBF24";
export const FUNDO_MAPA = "#0E0D12";

/** "#A78BFA" + 0.4 → "rgba(167,139,250,0.4)" */
export function comAlfa(hex: string, alfa: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alfa})`;
}
