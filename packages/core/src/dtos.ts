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
  pendencias: { tarefa: string; responsavel: string | null; prazo: string | null; criarTarefa?: boolean; /** nome antigo */ criarNoNotion?: boolean }[];
  clientes: string[];
}

export interface StatusIntegracaoDTO {
  nome: "claude" | "fathom" | "google" | "email" | "deepseek" | "embeddings" | "voz" | "fala" | "central";
  estado: "ativo" | "incompleto" | "desligado" | "erro";
  detalhe: string;
}

export interface ResumoInicioDTO {
  paraRevisar: RegistroResumoDTO[];
  vencidos: RegistroResumoDTO[];
  proximasReunioes: { titulo: string; inicio: string; link: string | null }[];
  atividade: { quando: string; descricao: string; registroId: string | null }[];
}

/** Grafo de conhecimento para a tela Mapa. */
export interface NoMapaDTO {
  id: string;
  /** registro = um POP, decisão etc.; area e cliente = nós de agrupamento. */
  categoria: "registro" | "area" | "cliente";
  rotulo: string;
  codigo: string | null;
  tipo: TipoRegistro | null;
  area: Area | null;
  status: StatusRegistro | null;
  restrito: boolean;
  /** Quantas ligações o nó tem (sem contar a da área): define o tamanho no desenho. */
  grau: number;
  atualizadoEm: string | null;
  /** Tarefas abertas ligadas a este registro. */
  tarefasAbertas: number;
}

export interface LigacaoMapaDTO {
  origem: string;
  destino: string;
  tipo: TipoRelacao | "area" | "cliente" | "semelhante";
  /** 0–1; só nas ligações por semelhança. */
  peso: number | null;
}

export interface MapaDTO {
  nos: NoMapaDTO[];
  ligacoes: LigacaoMapaDTO[];
  /** Como a semelhança foi medida: por sentido (embeddings) ou por palavras. */
  semelhanca: "embeddings" | "texto" | "desligada";
  geradoEm: string;
}

/** O que o Argos entendeu e o que fez. */
export interface RespostaAssistenteDTO {
  /** O que a pessoa falou (ou digitou). */
  texto: string;
  intencao: "perguntar" | "dados" | "pendencias" | "abrir" | "mapa" | "navegar" | "rascunho" | "conversa";
  /** Versão curta para ser falada em voz alta. */
  fala: string;
  /** Resposta completa em Markdown, quando houver. */
  detalhe: string | null;
  fontes: FonteDTO[];
  /** Tela para onde a interface deve ir, se o comando pedir. */
  acao: { destino: string; rotulo: string; automatica: boolean } | null;
  /** Quando a pergunta foi respondida consultando o banco da Central. */
  dados?: DadosCentralDTO | null;
  /** O Argos fez uma pergunta de volta (não teve certeza): a interface já volta a ouvir. */
  aguardaResposta?: boolean;
  /** O 1º trecho da fala, já sendo gerado no servidor: a interface toca direto de /argos/falar/:id. */
  voz?: { id: string; texto: string } | null;
  /** Quanto cada etapa levou (ms), para acompanhar a velocidade. */
  tempos?: Record<string, number>;
}

/** Resultado de uma consulta do Argos ao banco da Central. */
export interface DadosCentralDTO {
  titulo: string;
  /** "pronta" = consulta escrita à mão e testada; "livre" = SQL gerado pela IA para a pergunta. */
  origem: "pronta" | "livre";
  colunas: string[];
  linhas: Record<string, unknown>[];
  cortado: boolean;
  totais: Record<string, number | string | null>;
  destaques: { rotulo: string; valor: string }[];
  analise: string | null;
  /** Como o número foi obtido: a consulta exata, para conferir. */
  sql: string;
  explicacao: string | null;
  tabelas: string[];
  ms: number;
  /** Como desenhar os dados (a IA escolhe o tipo e as colunas; os números são sempre os da consulta). */
  grafico?: GraficoDTO | null;
}

export interface GraficoDTO {
  /** linha = ao longo do tempo; barras = comparar; pizza = partes de um todo. */
  tipo: "linha" | "barras" | "pizza";
  /** Coluna das categorias ou datas. */
  x: string;
  /** Colunas numéricas (até 3; pizza usa só a primeira). */
  y: string[];
  titulo: string | null;
  /** O gráfico abre primeiro (a pessoa pediu) ou fica como opção ao lado da tabela. */
  principal: boolean;
}

/** Tarefa do Cérebro (o que ficou combinado em reuniões, registros e com o Argos). */
export interface TarefaDTO {
  id: string;
  codigo: string;
  titulo: string;
  descricao: string;
  status: "a_fazer" | "fazendo" | "feita";
  ordem: number;
  responsavel: { id: string | null; nome: string } | null;
  prazo: string | null;
  atrasada: boolean;
  origem: "manual" | "ata" | "argos" | "claude" | "email";
  clienteRef: string | null;
  evento: { id: string; titulo: string; inicio: string | null; url: string | null } | null;
  /** Registros ligados (o primeiro é a origem, quando houver). */
  registros: { id: string; codigo: string; titulo: string; tipo: TipoRegistro; origem: boolean }[];
  criadoEm: string;
  atualizadoEm: string;
  concluidaEm: string | null;
}

export interface DetalheTarefaDTO extends TarefaDTO {
  historico: { quando: string; quem: string | null; acao: string }[];
}

export interface ResumoTarefasDTO {
  minhas: number;
  atrasadas: number;
  abertas: number;
}

/** Um item da aba Agenda: evento do Google, prazo de tarefa ou lembrete criado pelo Cérebro. */
export interface ItemAgendaDTO {
  id: string;
  tipo: "evento" | "tarefa" | "lembrete";
  titulo: string;
  /** ISO com hora, ou "AAAA-MM-DD" para o dia inteiro. */
  inicio: string;
  fim: string | null;
  diaInteiro: boolean;
  /** Link da chamada (Meet), quando houver. */
  chamada: string | null;
  /** Link para abrir o evento no Google Agenda. */
  url: string | null;
  participantes: string[];
  /** Tarefas abertas na pauta deste evento. */
  tarefas: { codigo: string; titulo: string }[];
  /** Para itens do tipo tarefa. */
  tarefa: { codigo: string; responsavel: string | null; atrasada: boolean } | null;
}

export interface AgendaDTO {
  de: string;
  ate: string;
  /** "ok" | "desligada" (sem Google) | "erro" (Google não respondeu). Os prazos das tarefas aparecem mesmo assim. */
  google: "ok" | "desligada" | "erro";
  itens: ItemAgendaDTO[];
}

/** E-mail recebido na caixa do Cérebro e o que aconteceu com ele. */
export interface EmailDTO {
  id: string;
  remetente: string;
  assunto: string;
  recebidoEm: string;
  trecho: string;
  /** analisando = IA ainda não leu; novo = sem IA ou falhou; registro = virou rascunho/registro; irrelevante = IA achou que não é conhecimento. */
  situacao: "analisando" | "novo" | "registro" | "irrelevante" | "ignorado" | "tarefa";
  pendente: boolean;
  registro: { id: string; codigo: string; titulo: string; status: string } | null;
  tarefa: { codigo: string; titulo: string; status: string } | null;
}

export interface CaixaEmailDTO {
  caixa: string | null;
  ultimaLeituraEm: string | null;
  pendentes: number;
  emails: EmailDTO[];
}
