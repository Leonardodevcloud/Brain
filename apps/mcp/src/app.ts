import express, { type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AppError } from "@cerebro/core";
import { acesso, type Contexto } from "@cerebro/servicos";
import { criarServidorMcp } from "./ferramentas.js";

/**
 * Servidor MCP (Streamable HTTP, sem sessão) para o conector personalizado do Claude.
 *
 * O token pessoal `cbr_…` (gerado em Integrações) pode vir:
 *  - no cabeçalho `Authorization: Bearer cbr_…`, ou
 *  - no caminho `/mcp/cbr_…` — é o formato que a tela de conectores do Claude aceita hoje.
 * Cada token é revogável e registra o último uso.
 */
export function criarAppMcp(ctx: Contexto) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", ctx.ambiente.CONFIAR_PROXY);
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/saude", (_req, res) => {
    res.json({ ok: true });
  });

  async function atender(req: Request, res: Response) {
    const cabecalho = req.get("authorization") ?? "";
    const token = (req.params.token as string | undefined) ?? (cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : "");
    let ator;
    try {
      ator = await acesso.autenticarConector(ctx, token);
    } catch (erro) {
      const mensagem = erro instanceof AppError ? erro.message : "Não autenticado.";
      return res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: mensagem }, id: null });
    }

    const servidor = criarServidorMcp(ctx, ator);
    const transporte = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transporte.close();
      void servidor.close();
    });
    try {
      await servidor.connect(transporte);
      await transporte.handleRequest(req, res, req.body);
    } catch (erro) {
      ctx.log.error({ erro }, "falha no MCP");
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno." }, id: null });
    }
  }

  // Sem sessão: GET (stream de eventos) e DELETE não se aplicam.
  const naoSuportado = (_req: Request, res: Response) =>
    res.status(405).set("allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null });

  app.post(["/mcp", "/mcp/:token"], atender);
  app.get(["/mcp", "/mcp/:token"], naoSuportado);
  app.delete(["/mcp", "/mcp/:token"], naoSuportado);
  return app;
}
