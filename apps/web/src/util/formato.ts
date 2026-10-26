import { NOME_AREA, NOME_TIPO, type Area, type Origem, type StatusRegistro, type TipoRegistro } from "@cerebro/core/publico";

const FUSO = "America/Bahia";

export const NOME_STATUS: Record<StatusRegistro, string> = {
  rascunho: "Rascunho",
  vigente: "Vigente",
  revisar: "Revisar",
  obsoleto: "Obsoleto",
  descartado: "Descartado",
};

export const NOME_ORIGEM: Record<Origem, string> = {
  manual: "Manual",
  claude: "Claude",
  reuniao: "Fathom",
  importacao: "Histórico do Claude",
  email: "E-mail",
};

/** Cor da etiqueta de cada tipo — poucas cores, só para escanear a lista. */
export const COR_TIPO: Record<TipoRegistro, string> = {
  reuniao: "etiqueta-roxa",
  decisao: "etiqueta-azul",
  politica: "etiqueta-azul",
  ocorrencia: "etiqueta-ambar",
  pop: "",
  cliente: "etiqueta-verde",
  sistema: "",
  indicador: "",
  nota: "",
};

export const COR_STATUS: Record<StatusRegistro, string> = {
  rascunho: "etiqueta-roxa",
  vigente: "etiqueta-verde",
  revisar: "etiqueta-ambar",
  obsoleto: "",
  descartado: "",
};

export const nomeTipo = (t: TipoRegistro) => (t === "reuniao" ? "Ata" : NOME_TIPO[t]);
export const nomeArea = (a: Area) => NOME_AREA[a];

export function dataCurta(iso: string | null | undefined) {
  if (!iso) return "—";
  // Datas puras (2026-10-28) não podem sofrer conversão de fuso.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: FUSO });
}

export function hora(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: FUSO });
}

export function dataLonga(d = new Date()) {
  const s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", timeZone: FUSO });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "há 2 h", "ontem", "há 3 dias". */
export function relativo(iso: string, agora = Date.now()) {
  const seg = Math.round((agora - new Date(iso).getTime()) / 1000);
  if (seg < 60) return "agora";
  if (seg < 3600) return `há ${Math.floor(seg / 60)} min`;
  if (seg < 86_400) return `há ${Math.floor(seg / 3600)} h`;
  const dias = Math.floor(seg / 86_400);
  if (dias === 1) return "ontem";
  if (dias < 30) return `há ${dias} dias`;
  return dataCurta(iso);
}

/** Dias até uma data (negativo = já passou). */
export function diasAte(dataIso: string, agora = new Date()) {
  const alvo = new Date(`${dataIso}T12:00:00Z`).getTime();
  const hoje = new Date(`${agora.toLocaleDateString("en-CA", { timeZone: FUSO })}T12:00:00Z`).getTime();
  return Math.round((alvo - hoje) / 86_400_000);
}

export function prazoRevisao(revisarEm: string | null) {
  if (!revisarEm) return null;
  const d = diasAte(revisarEm);
  if (d < 0) return { texto: `Vencido há ${-d} ${-d === 1 ? "dia" : "dias"}`, nivel: "erro" as const };
  if (d === 0) return { texto: "Vence hoje", nivel: "erro" as const };
  if (d <= 7) return { texto: `Vence em ${d} ${d === 1 ? "dia" : "dias"}`, nivel: "alerta" as const };
  return { texto: `Revisar em ${dataCurta(revisarEm)}`, nivel: "ok" as const };
}

export function iniciais(nome: string) {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function saudacao(d = new Date()) {
  const h = Number(d.toLocaleTimeString("en-GB", { hour: "2-digit", timeZone: FUSO }).slice(0, 2));
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}
