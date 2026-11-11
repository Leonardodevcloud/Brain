import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "@cerebro/core";
import { acesso, externo } from "@cerebro/servicos";
import { z } from "zod";
import { ator, validar, type Deps } from "../http/base.js";

/**
 * API para outros sistemas da empresa (hoje, o Prospect Team) — /api/externo.
 *
 * Autenticação: `Authorization: Bearer cbr_…` — token pessoal "de sistema", gerado em Integrações › Outros sistemas
 * (o token do conector do Claude não vale aqui, e este não vale no MCP).
 * Quem usa o token age como aquela pessoa, no canal "externo" (aparece assim na auditoria).
 * O cabeçalho opcional `X-Sistema` diz o nome do sistema (ex.: "Prospect Team").
 *
 * Só sai conhecimento valendo e não restrito, com dados pessoais mascarados.
 * O que entra vira rascunho — alguém aprova em Revisar.
 */
export function rotasExterno({ ctx }: Deps) {
  const r = Router();

  r.use(
    "/externo",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ erro: { codigo: "muitas_requisicoes", mensagem: "Muitas chamadas seguidas. Aguarde um minuto." } }),
    }),
  );

  const exigirToken: RequestHandler = async (req, _res, next) => {
    const cabecalho = req.get("authorization") ?? "";
    const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7).trim() : "";
    if (!token) return next(AppError.naoAutenticado("Mande o token do Cérebro no cabeçalho Authorization: Bearer cbr_…"));
    try {
      const quem = await acesso.autenticarConector(ctx, token, "sistema");
      req.ator = { ...quem, canal: "externo", ip: req.ip ?? null };
      next();
    } catch (erro) {
      next(erro instanceof AppError ? erro : AppError.naoAutenticado());
    }
  };
  r.use("/externo", exigirToken);

  const sistema = (cabecalho: string | undefined) => {
    const nome = (cabecalho ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 60);
    return nome.length >= 2 ? nome : "Sistema externo";
  };

  r.get("/externo/saude", async (req, res) => {
    res.json(await externo.quemSou(ctx, ator(req), sistema(req.get("x-sistema"))));
  });

  r.post("/externo/buscar", async (req, res) => {
    const entrada = validar(externo.esquemaBuscaExterna, { ...req.body, sistema: sistema(req.get("x-sistema")) });
    res.json(await externo.buscarParaSistema(ctx, ator(req), entrada));
  });

  r.get("/externo/registros/:codigo", async (req, res) => {
    const { codigo } = validar(z.object({ codigo: z.string().trim().regex(/^[A-Za-z]{2,4}-\d{1,6}$/, "Código como POP-014.") }), req.params);
    res.json(await externo.lerParaSistema(ctx, ator(req), codigo, sistema(req.get("x-sistema"))));
  });

  r.post("/externo/rascunhos", async (req, res) => {
    const entrada = validar(externo.esquemaRascunhoExterno, { ...req.body, sistema: sistema(req.get("x-sistema")) });
    const feito = await externo.guardarDoSistema(ctx, ator(req), entrada);
    res.status(feito.jaExistia ? 200 : 201).json(feito);
  });

  return r;
}
