import type {
  Area,
  Confidencialidade,
  Empresa,
  Origem,
  StatusRegistro,
  TipoRegistro,
  TipoRelacao,
} from "./constantes.js";

/** Formatos trocados entre a API e a interface. Datas sempre em ISO 8601. */

export type Papel = "admin" | "membro";

export interface UsuarioDTO {
  id: string;
  nome: string;
  email: string;
  papel: Papel;
}

export interface RegistroResumoDTO {
  id: string;
  codigo: string;
  tipo: TipoRegistro;
  titulo: string;
  status: StatusRegistro;
  area: Area;
  empresa: Empresa;
  origem: Origem;
  versao: number;
  revisarEm: string | null;
  atualizadoEm: string;
  dono: { id: string; nome: string } | null;
}

export interface RelacaoDTO {
  tipo: TipoRelacao;
  sentido: "saida" | "entrada";
  registro: { id: string; codigo: string; titulo: string; status: StatusRegistro };
}

export interface VersaoDTO {
  versao: number;
  motivo: string;
  autor: string | null;
  criadoEm: string;
}

export interface RegistroDTO extends RegistroResumoDTO {
  conteudo: string;
  confidencialidade: Confidencialidade;
  clienteRef: string | null;
  fonteUrl: string | null;
  dados: Record<string, unknown>;
  criadoEm: string;
  relacoes: RelacaoDTO[];
  versoes: VersaoDTO[];
}

export interface FonteDTO {
  indice: number;
  registroId: string;
  codigo: string;
  titulo: string;
  tipo: TipoRegistro;
  status: StatusRegistro;
  versao: number;
  revisarEm: string | null;
  trecho: string;
  pontuacao: number;
}

export interface RespostaPerguntaDTO {
  pergunta: string;
  /** `null` quando não há base suficiente ou a IA está indisponível. */
  resposta: string | null;
  fontes: FonteDTO[];
  /** A pergunta não teve registro relevante e foi para a fila de lacunas. */
  lacuna: boolean;
  /** Algum registro usado está em revisão ou é rascunho. */
  avisos: string[];
}

/** Estrutura que a IA preenche ao transformar uma reunião em ata. */
export interface AtaDados {
  reuniaoId: string;
  resumo: string;
  decisoes: { texto: string; aprovar: boolean }[];
  pendencias: { tarefa: string; responsavel: string | null; prazo: string | null; criarNoNotion: boolean }[];
  clientes: string[];
  tarefasCriadas?: { tarefa: string; notionUrl: string }[];
}

export interface StatusIntegracaoDTO {
  nome: "claude" | "fathom" | "google" | "notion" | "email" | "deepseek" | "embeddings";
  estado: "ativo" | "incompleto" | "desligado" | "erro";
  detalhe: string;
}

export interface ResumoInicioDTO {
  paraRevisar: RegistroResumoDTO[];
  vencidos: RegistroResumoDTO[];
  proximasReunioes: { titulo: string; inicio: string; link: string | null }[];
  atividade: { quando: string; descricao: string; registroId: string | null }[];
}
