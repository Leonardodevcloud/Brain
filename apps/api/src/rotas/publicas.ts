import express, { Router } from "express";
import { AppError } from "@cerebro/core";
import { lerReuniaoFathom, verificarAssinaturaFathom } from "@cerebro/integracoes";
import { fontes, painel } from "@cerebro/servicos";
import type { Deps } from "../http/base.js";

/** Rotas sem login: saúde, retorno do Google e webhook da Fathom (cada uma com sua própria verificação). */
export function rotasPublicas({ ctx }: Deps) {
  const r = Router();

  r.get("/saude", async (_req, res) => {
    await ctx.pool.query("SELECT 1");
    res.json({ ok: true });
  });

  // O Google redireciona o navegador para cá; o `state` amarra ao pedido feito por um admin.
  r.get("/integracoes/google/retorno", async (req, res) => {
    const destino = new URL("/integracoes", ctx.ambiente.URL_WEB);
    const { code, state, error } = req.query as Record<string, string | undefined>;
    try {
      if (error || !code || !state) throw AppError.requisicaoInvalida("A autorização foi cancelada.");
      await painel.concluirConexaoGoogle(ctx, code, state);
      destino.searchParams.set("google", "ok");
    } catch (erro) {
      ctx.log.warn({ erro }, "falha ao conectar o Google");
      destino.searchParams.set("google", "erro");
    }
    res.redirect(303, destino.toString());
  });

  // Corpo bruto: a assinatura é calculada sobre os bytes exatos.
  r.post("/webhooks/fathom", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const segredo = ctx.ambiente.FATHOM_WEBHOOK_SEGREDO;
    if (!segredo) throw AppError.indisponivel("Webhook da Fathom não configurado.");
    const corpo = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const valido = verificarAssinaturaFathom(
      segredo,
      { id: req.get("webhook-id"), timestamp: req.get("webhook-timestamp"), assinatura: req.get("webhook-signature") },
      corpo,
    );
    if (!valido) throw AppError.naoAutenticado("Assinatura do webhook inválida.");

    let payload: unknown;
    try {
      payload = JSON.parse(corpo);
    } catch {
      throw AppError.requisicaoInvalida("Corpo do webhook não é JSON.");
    }
    const reuniao = lerReuniaoFathom(payload);
    if (!reuniao) {
      // Evento sem transcrição (ou de outro tipo): confirma para a Fathom não reenviar.
      ctx.log.info({ chaves: Object.keys(payload as object) }, "webhook da Fathom ignorado");
      return res.status(202).json({ ignorado: true });
    }
    const { nova } = await fontes.registrarReuniao(ctx, reuniao);
    res.status(202).json({ recebida: true, nova });
  });

  return r;
}
