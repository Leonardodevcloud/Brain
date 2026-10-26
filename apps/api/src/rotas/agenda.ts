import { Router } from "express";
import { agenda, caixaEmail } from "@cerebro/servicos";
import { ator, esquemaId, validar, type Deps } from "../http/base.js";

/** Abas Agenda e E-mail. */
export function rotasAgenda({ ctx }: Deps) {
  const r = Router();

  // ?de=AAAA-MM-DD&dias=7
  r.get("/agenda", async (req, res) => {
    const de = typeof req.query.de === "string" ? req.query.de : null;
    res.json(await agenda.listarAgenda(ctx, ator(req), de, Number(req.query.dias ?? 7)));
  });

  r.post("/agenda/lembretes", async (req, res) => {
    res.status(201).json(await agenda.criarLembrete(ctx, ator(req), req.body ?? {}));
  });

  // ?filtro=todos|pendentes|registro|ignorados
  r.get("/emails", async (req, res) => {
    res.json(await caixaEmail.listarEmails(ctx, req.query.filtro));
  });

  r.get("/emails/pendentes", async (_req, res) => {
    res.json({ pendentes: await caixaEmail.contarPendentes(ctx) });
  });

  r.post("/emails/:id/ignorar", async (req, res) => {
    res.json(await caixaEmail.ignorarEmail(ctx, ator(req), validar(esquemaId, req.params).id, req.body?.desfazer === true));
  });

  r.post("/emails/:id/tarefa", async (req, res) => {
    res.json(await caixaEmail.emailParaTarefa(ctx, ator(req), validar(esquemaId, req.params).id));
  });

  r.post("/emails/:id/registro", async (req, res) => {
    res.json(await caixaEmail.emailParaRegistro(ctx, ator(req), validar(esquemaId, req.params).id));
  });

  return r;
}
