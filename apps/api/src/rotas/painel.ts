import express, { Router } from "express";
import { AppError } from "@cerebro/core";
import { acesso, fontes, painel } from "@cerebro/servicos";
import { z } from "zod";
import { ator, esquemaId, exigirAdmin, validar, type Deps } from "../http/base.js";

const esquemaNovoUsuario = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  senha: z.string().min(1).max(200),
  papel: z.enum(["admin", "membro"]).default("membro"),
});

const esquemaMapaNotion = z.object({
  databaseId: z.string().trim().min(10).max(100),
  propTitulo: z.string().trim().min(1).max(100),
  propPrazo: z.string().trim().max(100).nullish(),
  propResponsavel: z.string().trim().max(100).nullish(),
  tipoResponsavel: z.enum(["rich_text", "select"]).optional(),
  propStatus: z.string().trim().max(100).nullish(),
  tipoStatus: z.enum(["status", "select"]).optional(),
  valorStatusInicial: z.string().trim().max(100).nullish(),
  propOrigem: z.string().trim().max(100).nullish(),
});

/** Rotas de tela: início, lacunas, usuários, integrações, conector e importação. Todas exigem login. */
export function rotasPainel({ ctx }: Deps) {
  const r = Router();

  r.get("/inicio", async (_req, res) => {
    res.json(await painel.resumoInicio(ctx));
  });

  r.get("/lacunas", async (_req, res) => {
    res.json(await painel.listarLacunas(ctx));
  });

  r.post("/lacunas/:id/resolver", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { registroId } = validar(z.object({ registroId: z.uuid().nullish() }), req.body ?? {});
    await painel.resolverLacuna(ctx, ator(req), id, registroId ?? null);
    res.status(204).end();
  });

  // ── Usuários ──
  r.get("/usuarios", async (_req, res) => {
    res.json(await acesso.listarUsuarios(ctx));
  });

  r.post("/usuarios", exigirAdmin, async (req, res) => {
    res.status(201).json(await acesso.criarUsuario(ctx, ator(req), validar(esquemaNovoUsuario, req.body)));
  });

  // ── Integrações ──
  r.get("/integracoes", async (req, res) => {
    res.json(await painel.statusIntegracoes(ctx, ator(req)));
  });

  r.post("/integracoes/google/conectar", exigirAdmin, async (req, res) => {
    res.json({ url: await painel.iniciarConexaoGoogle(ctx, ator(req)) });
  });

  r.get("/integracoes/notion/colunas", exigirAdmin, async (req, res) => {
    const { databaseId } = validar(z.object({ databaseId: z.string().trim().min(10).max(100) }), req.query);
    res.json(await painel.colunasNotion(ctx, databaseId));
  });

  r.put("/integracoes/notion/mapa", exigirAdmin, async (req, res) => {
    await painel.salvarMapaNotion(ctx, ator(req), validar(esquemaMapaNotion, req.body));
    res.status(204).end();
  });

  r.get("/integracoes/fila", exigirAdmin, async (_req, res) => {
    res.json(await painel.saudeFila(ctx));
  });

  // ── Conector do Claude (tokens pessoais) ──
  r.get("/conector/tokens", async (req, res) => {
    res.json(await acesso.listarTokensConector(ctx, ator(req)));
  });

  r.post("/conector/tokens", async (req, res) => {
    const { nome } = validar(z.object({ nome: z.string().trim().min(2).max(60) }), req.body);
    res.status(201).json(await acesso.criarTokenConector(ctx, ator(req), nome));
  });

  r.delete("/conector/tokens/:id", async (req, res) => {
    await acesso.revogarTokenConector(ctx, ator(req), validar(esquemaId, req.params).id);
    res.status(204).end();
  });

  // ── Importação do Claude: o .zip vai direto no corpo ──
  r.post(
    "/importacao/claude",
    exigirAdmin,
    express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "150mb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw AppError.requisicaoInvalida("Envie o arquivo .zip exportado do Claude.");
      }
      try {
        res.json(await fontes.importarExportacaoClaude(ctx, ator(req), new Uint8Array(req.body)));
      } catch (erro) {
        if (erro instanceof AppError) throw erro;
        throw AppError.requisicaoInvalida("Não consegui ler o arquivo. Confira se é o .zip exportado em Configurações › Privacidade do Claude.");
      }
    },
  );

  return r;
}
