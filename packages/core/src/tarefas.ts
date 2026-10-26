import { z } from "zod";
import { STATUS_TAREFA } from "./constantes.js";

const data = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.")
  .nullish();

export const esquemaCriarTarefa = z.object({
  titulo: z.string().trim().min(2, "Escreva a tarefa.").max(300),
  descricao: z.string().max(10_000).default(""),
  status: z.enum(STATUS_TAREFA).default("a_fazer"),
  responsavelId: z.uuid().nullish(),
  responsavelTexto: z.string().trim().max(120).nullish(),
  prazo: data,
  clienteRef: z.string().trim().max(200).nullish(),
  registros: z.array(z.uuid()).max(20).default([]),
});
export type CriarTarefa = z.infer<typeof esquemaCriarTarefa>;

export const esquemaAtualizarTarefa = z
  .object({
    titulo: z.string().trim().min(2).max(300),
    descricao: z.string().max(10_000),
    status: z.enum(STATUS_TAREFA),
    responsavelId: z.uuid().nullable(),
    responsavelTexto: z.string().trim().max(120).nullable(),
    prazo: data,
    clienteRef: z.string().trim().max(200).nullable(),
  })
  .partial();
export type AtualizarTarefa = z.infer<typeof esquemaAtualizarTarefa>;

/** Arrastar no quadro: nova coluna e antes de qual tarefa (null = no fim). */
export const esquemaMoverTarefa = z.object({
  status: z.enum(STATUS_TAREFA),
  antesDe: z.uuid().nullable().default(null),
});

export const esquemaFiltroTarefas = z.object({
  filtro: z.enum(["minhas", "todas", "atrasadas", "feitas"]).default("todas"),
  texto: z.string().trim().max(120).optional(),
  registroId: z.uuid().optional(),
});
