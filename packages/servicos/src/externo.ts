import {
  AREAS,
  AppError,
  NOME_TIPO,
  STATUS_CONSULTAVEIS,
  TIPOS_REGISTRO,
  esquemaCriarRegistro,
  type RegistroDTO,
} from "@cerebro/core";
import { lacunas, registros as repoRegistros, usuarios } from "@cerebro/db";
import { mascarar } from "@cerebro/ia";
import { z } from "zod";
import { buscar } from "./busca.js";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { criarRegistro, obterRegistro } from "./registros.js";

/**
 * Outros sistemas da empresa (hoje, o Prospect Team) lendo e alimentando o Cérebro.
 *
 * Regras que não mudam:
 *  - só sai o que está valendo (vigente ou em revisão) e não é restrito;
 *  - dados pessoais (e-mail, CPF, CNPJ, telefone, placa, conta, PIX) saem mascarados;
 *  - o que chega entra SEMPRE como rascunho, para alguém aprovar em Revisar;
 *  - toda chamada fica na auditoria, com o canal "externo".
 */

export const VIA_EXTERNO = "externo";

/** Tipos que um sistema de fora pode mandar. Regra e decisão ficam com as pessoas. */
export const TIPOS_DO_SISTEMA = ["nota", "indicador", "ocorrencia"] as const satisfies readonly (typeof TIPOS_REGISTRO)[number][];

const nomeDoSistema = z.string().trim().min(2).max(60).default("Sistema externo");

export const esquemaBuscaExterna = z.object({
  pergunta: z.string().trim().min(3).max(1000),
  tipo: z.enum(TIPOS_REGISTRO).optional(),
  area: z.enum(AREAS).optional(),
  cliente: z.string().trim().max(120).optional(),
  limite: z.coerce.number().int().min(1).max(6).default(6),
  sistema: nomeDoSistema,
});
export type BuscaExterna = z.infer<typeof esquemaBuscaExterna>;

export const esquemaRascunhoExterno = z.object({
  tipo: z.enum(TIPOS_DO_SISTEMA).default("nota"),
  titulo: z.string().trim().min(3).max(200),
  conteudo: z.string().trim().min(10).max(50_000),
  area: z.enum(AREAS).default("marketing"),
  cliente: z.string().trim().max(120).optional(),
  /** Chave do lado de lá (ex.: "aprendizados-2026-W45"): mandar de novo não duplica. */
  idExterno: z.string().trim().min(1).max(120).optional(),
  sistema: nomeDoSistema,
});
export type RascunhoExterno = z.infer<typeof esquemaRascunhoExterno>;

export interface FonteExterna {
  codigo: string;
  titulo: string;
  tipo: string;
  tipoNome: string;
  status: string;
  versao: number;
  emRevisao: boolean;
  trecho: string;
  link: string;
}

export interface RegistroExterno {
  codigo: string;
  titulo: string;
  tipo: string;
  tipoNome: string;
  area: string;
  empresa: string;
  status: string;
  versao: number;
  revisarEm: string | null;
  atualizadoEm: string;
  conteudo: string;
  link: string;
  relacionados: { tipo: string; codigo: string; titulo: string }[];
}

const linkDo = (ctx: Contexto, codigo: string) => `${ctx.ambiente.URL_WEB.replace(/\/$/, "")}/registros/${codigo}`;

/** Esconde dados pessoais antes do texto sair. O mapa fica aqui e é descartado. */
const semDadosPessoais = (texto: string) => mascarar(texto).texto;

function exigirPessoa(ator: Ator) {
  if (!ator.usuarioId) throw AppError.naoAutenticado();
}

/** Para o "Testar conexão" do outro sistema: de quem é o token e o que dá para fazer. */
export async function quemSou(ctx: Contexto, ator: Ator, sistema = "Sistema externo") {
  exigirPessoa(ator);
  const u = await usuarios.buscarPorId(ctx.pool, ator.usuarioId!);
  if (!u) throw AppError.naoAutenticado();
  await auditar(ctx.pool, ator, "externo.teste", undefined, { sistema });
  return {
    ok: true,
    cerebro: "Cérebro · Central Tutts",
    versao: 1,
    usuario: { nome: u.nome, papel: u.papel },
    pode: { buscar: true, ler: true, guardarRascunho: true },
    tiposQueAceita: TIPOS_DO_SISTEMA,
    areas: AREAS,
  };
}

/** Busca no conhecimento valendo, sem restritos e sem rascunhos. */
export async function buscarParaSistema(ctx: Contexto, ator: Ator, entrada: BuscaExterna) {
  exigirPessoa(ator);
  const fontes = await buscar(ctx, {
    pergunta: entrada.pergunta,
    tipo: entrada.tipo,
    area: entrada.area,
    clienteRef: entrada.cliente,
    incluirRascunhos: false,
    incluirRestritos: false,
  });
  const itens: FonteExterna[] = fontes.slice(0, entrada.limite).map((f) => ({
    codigo: f.codigo,
    titulo: semDadosPessoais(f.titulo),
    tipo: f.tipo,
    tipoNome: NOME_TIPO[f.tipo],
    status: f.status,
    versao: f.versao,
    emRevisao: f.status === "revisar",
    trecho: semDadosPessoais(f.trecho),
    link: linkDo(ctx, f.codigo),
  }));
  if (!itens.length) await lacunas.registrar(ctx.pool, entrada.pergunta, ator.usuarioId, ator.canal);
  await auditar(ctx.pool, ator, "externo.busca", undefined, {
    sistema: entrada.sistema,
    resultados: itens.length,
    codigos: itens.map((i) => i.codigo),
  });
  return { itens, lacuna: itens.length === 0 };
}

/** Lê um registro inteiro. Restrito, rascunho, obsoleto e descartado não saem. */
export async function lerParaSistema(ctx: Contexto, ator: Ator, codigo: string, sistema = "Sistema externo") {
  exigirPessoa(ator);
  let r: RegistroDTO;
  try {
    r = await obterRegistro(ctx, codigo.trim().toUpperCase());
  } catch (erro) {
    if (erro instanceof AppError && erro.status === 404) throw AppError.naoEncontrado("O registro");
    throw erro;
  }
  // Para quem está de fora, restrito e fora de uso são "não existe": não confirma que existem.
  if (r.confidencialidade === "restrito" || !STATUS_CONSULTAVEIS.includes(r.status)) {
    await auditar(ctx.pool, ator, "externo.leitura_negada", { entidade: "registro", id: r.id }, { sistema });
    throw AppError.naoEncontrado("O registro");
  }
  await auditar(ctx.pool, ator, "externo.leitura", { entidade: "registro", id: r.id }, { sistema, codigo: r.codigo });
  const saida: RegistroExterno = {
    codigo: r.codigo,
    titulo: semDadosPessoais(r.titulo),
    tipo: r.tipo,
    tipoNome: NOME_TIPO[r.tipo],
    area: r.area,
    empresa: r.empresa,
    status: r.status,
    versao: r.versao,
    revisarEm: r.revisarEm,
    atualizadoEm: r.atualizadoEm,
    conteudo: semDadosPessoais(r.conteudo),
    link: linkDo(ctx, r.codigo),
    relacionados: r.relacoes
      .filter((x) => STATUS_CONSULTAVEIS.includes(x.registro.status))
      .map((x) => ({ tipo: x.tipo, codigo: x.registro.codigo, titulo: semDadosPessoais(x.registro.titulo) })),
  };
  return saida;
}

/** Guarda o que o sistema aprendeu como RASCUNHO. Com idExterno, mandar de novo não duplica. */
export async function guardarDoSistema(ctx: Contexto, ator: Ator, entrada: RascunhoExterno) {
  exigirPessoa(ator);
  const chave = entrada.idExterno ? `${VIA_EXTERNO}:${ator.usuarioId}:${entrada.idExterno}` : null;
  if (chave) {
    const existente = await repoRegistros.buscarPorOrigemExterna(ctx.pool, chave);
    if (existente) {
      return { codigo: existente.codigo, status: existente.status, link: linkDo(ctx, existente.codigo), jaExistia: true };
    }
  }
  const registro = esquemaCriarRegistro.parse({
    tipo: entrada.tipo,
    titulo: entrada.titulo,
    conteudo: `${entrada.conteudo}\n\n---\nEnviado por ${entrada.sistema}.`,
    area: entrada.area,
    clienteRef: entrada.cliente,
    dados: { via: VIA_EXTERNO, sistema: entrada.sistema, ...(chave ? { origemExternaId: chave } : {}) },
  });
  const r = await criarRegistro(ctx, ator, registro, { origem: "externo", sempreRascunho: true });
  return { codigo: r.codigo, status: r.status, link: linkDo(ctx, r.codigo), jaExistia: false };
}
