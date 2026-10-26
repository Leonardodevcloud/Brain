import { z } from "zod";
import {
  AREAS,
  CONFIDENCIALIDADES,
  EMPRESAS,
  STATUS_REGISTRO,
  TIPOS_REGISTRO,
  TIPOS_RELACAO,
} from "./constantes.js";

export * from "./constantes.js";

// ───────────────────────── Validação de entrada ─────────────────────────

const textoLimpo = (min: number, max: number) => z.string().trim().min(min).max(max);

export const esquemaCriarRegistro = z.object({
  tipo: z.enum(TIPOS_REGISTRO),
  titulo: textoLimpo(3, 200),
  conteudo: textoLimpo(1, 520_000),
  area: z.enum(AREAS).default("operacoes"),
  empresa: z.enum(EMPRESAS).default("todas"),
  confidencialidade: z.enum(CONFIDENCIALIDADES).default("interno"),
  donoId: z.uuid().nullish(),
  clienteRef: textoLimpo(1, 120).nullish(),
  fonteUrl: z.url().max(2000).nullish(),
  dados: z.record(z.string(), z.unknown()).default({}),
  /** Só quem cria pela tela pode publicar direto; o resto nasce rascunho. */
  publicar: z.boolean().default(false),
  relacoes: z
    .array(z.object({ destinoId: z.uuid(), tipo: z.enum(TIPOS_RELACAO) }))
    .max(50)
    .default([]),
});
export type CriarRegistro = z.infer<typeof esquemaCriarRegistro>;

export const esquemaAtualizarRegistro = z
  .object({
    titulo: textoLimpo(3, 200).optional(),
    conteudo: textoLimpo(1, 520_000).optional(),
    area: z.enum(AREAS).optional(),
    empresa: z.enum(EMPRESAS).optional(),
    confidencialidade: z.enum(CONFIDENCIALIDADES).optional(),
    donoId: z.uuid().nullable().optional(),
    clienteRef: textoLimpo(1, 120).nullable().optional(),
    revisarEm: z.iso.date().nullable().optional(),
    dados: z.record(z.string(), z.unknown()).optional(),
    motivo: textoLimpo(3, 300),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "motivo"), {
    message: "Informe pelo menos um campo para alterar.",
  });
export type AtualizarRegistro = z.infer<typeof esquemaAtualizarRegistro>;

export const esquemaFiltroRegistros = z.object({
  tipo: z.enum(TIPOS_REGISTRO).optional(),
  status: z.enum(STATUS_REGISTRO).optional(),
  area: z.enum(AREAS).optional(),
  texto: z.string().trim().max(200).optional(),
  pagina: z.coerce.number().int().min(1).default(1),
  porPagina: z.coerce.number().int().min(1).max(100).default(30),
});
export type FiltroRegistros = z.infer<typeof esquemaFiltroRegistros>;

export const esquemaPergunta = z.object({
  pergunta: textoLimpo(3, 1000),
  tipo: z.enum(TIPOS_REGISTRO).optional(),
  area: z.enum(AREAS).optional(),
  clienteRef: z.string().trim().max(120).optional(),
  incluirRascunhos: z.boolean().default(false),
});
export type Pergunta = z.infer<typeof esquemaPergunta>;
