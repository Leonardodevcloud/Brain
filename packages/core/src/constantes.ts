/** Constantes e tipos puros (sem zod): seguros para a interface web. */
/** Os 10 tipos de registro do cérebro. Um tipo novo só entra quando nenhum destes serve. */
export const TIPOS_REGISTRO = [
  "pop",
  "decisao",
  "ocorrencia",
  "politica",
  "cliente",
  "sistema",
  "indicador",
  "reuniao",
  "nota",
  "documento",
] as const;
export type TipoRegistro = (typeof TIPOS_REGISTRO)[number];

export const STATUS_REGISTRO = ["rascunho", "vigente", "revisar", "obsoleto", "descartado"] as const;
export type StatusRegistro = (typeof STATUS_REGISTRO)[number];

export const AREAS = [
  "operacoes",
  "financeiro",
  "comercial",
  "tecnologia",
  "pessoas",
  "marketing",
  "gestao",
  "atendimento",
] as const;
export type Area = (typeof AREAS)[number];

export const EMPRESAS = ["todas", "tutts", "fiix", "ig"] as const;
export type Empresa = (typeof EMPRESAS)[number];

export const ORIGENS = ["manual", "claude", "reuniao", "importacao", "email", "upload"] as const;
export type Origem = (typeof ORIGENS)[number];

export const CONFIDENCIALIDADES = ["interno", "restrito"] as const;
export type Confidencialidade = (typeof CONFIDENCIALIDADES)[number];

export const TIPOS_RELACAO = ["referencia", "implementa", "substitui", "contradiz"] as const;
export type TipoRelacao = (typeof TIPOS_RELACAO)[number];

/** Prefixo do código legível de cada tipo (POP-014, DEC-031...). */
export const PREFIXO_CODIGO: Record<TipoRegistro, string> = {
  pop: "POP",
  decisao: "DEC",
  ocorrencia: "OC",
  politica: "POL",
  cliente: "CLI",
  sistema: "SIS",
  indicador: "IND",
  reuniao: "REU",
  nota: "NOT",
  documento: "DOC",
};

export const NOME_TIPO: Record<TipoRegistro, string> = {
  pop: "POP",
  decisao: "Decisão",
  ocorrencia: "Ocorrência",
  politica: "Regra",
  cliente: "Cliente",
  sistema: "Sistema",
  indicador: "Indicador",
  reuniao: "Ata",
  nota: "Nota",
  documento: "Documento",
};

export const NOME_AREA: Record<Area, string> = {
  operacoes: "Operações",
  financeiro: "Financeiro",
  comercial: "Comercial",
  tecnologia: "Tecnologia",
  pessoas: "Pessoas",
  marketing: "Marketing",
  gestao: "Gestão",
  atendimento: "Atendimento",
};

/**
 * Dias até a próxima revisão obrigatória, por tipo.
 * `null` = o registro não vence (decisões só mudam quando substituídas).
 */
export const DIAS_REVISAO: Record<TipoRegistro, number | null> = {
  pop: 90,
  decisao: null,
  ocorrencia: 120,
  politica: 180,
  cliente: 60,
  sistema: null,
  indicador: 180,
  reuniao: null,
  nota: 7,
  documento: 365,
};

/** Data (AAAA-MM-DD) da próxima revisão a partir de `base`. */
export function calcularRevisarEm(tipo: TipoRegistro, base = new Date()): string | null {
  const dias = DIAS_REVISAO[tipo];
  if (dias === null) return null;
  const data = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

export function formatarCodigo(tipo: TipoRegistro, numero: number): string {
  return `${PREFIXO_CODIGO[tipo]}-${String(numero).padStart(3, "0")}`;
}

/** Status que aparecem nas respostas da IA. Rascunho aparece só se pedido. */
export const STATUS_CONSULTAVEIS: StatusRegistro[] = ["vigente", "revisar"];


/** Situações de uma tarefa (as colunas do quadro). */
export const STATUS_TAREFA = ["a_fazer", "fazendo", "feita"] as const;
export const NOME_STATUS_TAREFA = { a_fazer: "A fazer", fazendo: "Fazendo", feita: "Feita" } as const;
