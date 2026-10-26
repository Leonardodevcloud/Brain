import { Router } from "express";
import { esquemaAtualizarTarefa, esquemaCriarTarefa, esquemaFiltroTarefas, esquemaMoverTarefa } from "@cerebro/core";
import { tarefas } from "@cerebro/servicos";
import { z } from "zod";
import { ator, esquemaId, validar, type Deps } from "../http/base.js";

/** Tarefas do Cérebro: lista, quadro, detalhe e agenda. */
export function rotasTarefas({ ctx }: Deps) {
  const r = Router();

  r.get("/tarefas", async (req, res) => {
    res.json(await tarefas.listarTarefas(ctx, ator(req), validar(esquemaFiltroTarefas, req.query)));
  });

  r.get("/tarefas/resumo", async (req, res) => {
    res.json(await tarefas.resumoTarefas(ctx, ator(req)));
  });

  // Reuniões dos próximos dias, para ligar a tarefa (entra na pauta).
  r.get("/tarefas/reunioes", async (_req, res) => {
    res.json(await tarefas.reunioesParaLigar(ctx));
  });

  r.post("/tarefas", async (req, res) => {
    res.status(201).json(await tarefas.criarTarefa(ctx, ator(req), validar(esquemaCriarTarefa, req.body)));
  });

  // Aceita o id ou o código (TAR-018).
  r.get("/tarefas/:id", async (req, res) => {
    res.json(await tarefas.obterTarefa(ctx, validar(esquemaId, req.params).id));
  });

  r.patch("/tarefas/:id", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    res.json(await tarefas.atualizarTarefa(ctx, ator(req), id, validar(esquemaAtualizarTarefa, req.body)));
  });

  r.post("/tarefas/:id/mover", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    res.json(await tarefas.moverTarefa(ctx, ator(req), id, validar(esquemaMoverTarefa, req.body)));
  });

  r.delete("/tarefas/:id", async (req, res) => {
    await tarefas.excluirTarefa(ctx, ator(req), validar(esquemaId, req.params).id);
    res.status(204).end();
  });

  r.post("/tarefas/:id/registros", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { registroId, ligar } = validar(z.object({ registroId: z.uuid(), ligar: z.boolean().default(true) }), req.body);
    res.json(await tarefas.ligarRegistro(ctx, ator(req), id, registroId, ligar));
  });

  r.post("/tarefas/:id/reuniao", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { eventoId } = validar(z.object({ eventoId: z.string().min(1).max(300).nullable() }), req.body);
    res.json(eventoId ? await tarefas.ligarReuniao(ctx, ator(req), id, eventoId) : await tarefas.desligarReuniao(ctx, ator(req), id));
  });

  r.post("/tarefas/:id/lembrete", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { quando } = validar(z.object({ quando: z.string().max(40).nullish() }), req.body ?? {});
    res.json(await tarefas.criarLembrete(ctx, ator(req), id, quando));
  });

  return r;
}
