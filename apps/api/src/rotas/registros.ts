import { Router } from "express";
import {
  esquemaAtualizarRegistro,
  esquemaCriarRegistro,
  esquemaFiltroRegistros,
  esquemaPergunta,
} from "@cerebro/core";
import { conhecimento, responder } from "@cerebro/servicos";
import { z } from "zod";
import { ator, esquemaId, validar, type Deps } from "../http/base.js";

const esquemaAprovar = z.object({
  decisoes: z.array(z.number().int().min(0)).max(100).optional(),
  pendencias: z.array(z.number().int().min(0)).max(100).optional(),
});
const esquemaObsoleto = z.object({ motivo: z.string().trim().min(3).max(300) });

export function rotasRegistros({ ctx }: Deps) {
  const r = Router();

  r.get("/registros", async (req, res) => {
    res.json(await conhecimento.listarRegistros(ctx, validar(esquemaFiltroRegistros, req.query)));
  });

  r.post("/registros", async (req, res) => {
    const entrada = validar(esquemaCriarRegistro, req.body);
    res.status(201).json(await conhecimento.criarRegistro(ctx, ator(req), entrada, { origem: "manual" }));
  });

  // Aceita o id ou o código (POP-014).
  r.get("/registros/:id", async (req, res) => {
    res.json(await conhecimento.obterRegistro(ctx, validar(esquemaId, req.params).id));
  });

  r.patch("/registros/:id", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    res.json(await conhecimento.atualizarRegistro(ctx, ator(req), id, validar(esquemaAtualizarRegistro, req.body)));
  });

  r.post("/registros/:id/aprovar", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    res.json(await conhecimento.aprovarRegistro(ctx, ator(req), id, validar(esquemaAprovar, req.body ?? {})));
  });

  r.post("/registros/:id/descartar", async (req, res) => {
    res.json(await conhecimento.descartarRegistro(ctx, ator(req), validar(esquemaId, req.params).id));
  });

  r.post("/registros/:id/revisado", async (req, res) => {
    res.json(await conhecimento.confirmarRevisao(ctx, ator(req), validar(esquemaId, req.params).id));
  });

  r.post("/registros/:id/obsoleto", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { motivo } = validar(esquemaObsoleto, req.body);
    res.json(await conhecimento.tornarObsoleto(ctx, ator(req), id, motivo));
  });

  r.post("/perguntar", async (req, res) => {
    res.json(await responder(ctx, ator(req), validar(esquemaPergunta, req.body)));
  });

  return r;
}
