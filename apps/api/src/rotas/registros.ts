import express, { Router } from "express";
import {
  AppError,
  esquemaAtualizarRegistro,
  esquemaCriarRegistro,
  esquemaFiltroRegistros,
  esquemaPergunta,
} from "@cerebro/core";
import { conhecimento, documentos, responder } from "@cerebro/servicos";
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

  // Apaga de vez (administrador). O corpo repete o código: { "confirmacao": "POP-014" }.
  r.delete("/registros/:id", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { confirmacao } = validar(z.object({ confirmacao: z.string().trim().min(3).max(20) }), req.body ?? {});
    await conhecimento.excluirRegistro(ctx, ator(req), id, confirmacao);
    res.status(204).end();
  });

  // Documento enviado: o arquivo vai cru no corpo; nome e área na query.
  r.post(
    "/documentos",
    express.raw({ type: () => true, limit: documentos.LIMITE_DOCUMENTO_BYTES }),
    async (req, res) => {
      const q = validar(
        z.object({
          nome: z.string().trim().min(3).max(200),
          titulo: z.string().trim().max(200).optional(),
          area: z.string().max(30).optional(),
          confidencialidade: z.string().max(20).optional(),
          clienteRef: z.string().trim().max(120).optional(),
        }),
        req.query,
      );
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw AppError.requisicaoInvalida("Envie o arquivo.");
      res.status(201).json(await documentos.enviarDocumento(ctx, ator(req), { ...q, bytes: new Uint8Array(req.body) }));
    },
  );

  r.get("/registros/:id/arquivo", async (req, res) => {
    const a = await documentos.baixarArquivo(ctx, validar(esquemaId, req.params).id);
    res.set({
      "content-type": a.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.nome)}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    res.send(a.conteudo);
  });

  r.post("/registros/:id/descartar", async (req, res) => {
    await conhecimento.descartarRegistro(ctx, ator(req), validar(esquemaId, req.params).id);
    res.status(204).end();
  });

  // Devolve o registro atualizado: a tela mostra a nova data de revisão.
  r.post("/registros/:id/revisado", async (req, res) => {
    res.json(await conhecimento.confirmarRevisao(ctx, ator(req), validar(esquemaId, req.params).id));
  });

  r.post("/registros/:id/obsoleto", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { motivo } = validar(esquemaObsoleto, req.body);
    await conhecimento.tornarObsoleto(ctx, ator(req), id, motivo);
    res.status(204).end();
  });

  r.post("/perguntar", async (req, res) => {
    res.json(await responder(ctx, ator(req), validar(esquemaPergunta, req.body)));
  });

  return r;
}
