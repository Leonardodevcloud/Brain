import cookieParser from "cookie-parser";
import express, { Router } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { exigirLogin, tratarErros, type Deps } from "./http/base.js";
import { rotasAgenda } from "./rotas/agenda.js";
import { rotasAuth } from "./rotas/auth.js";
import { rotasFala, rotasPainel } from "./rotas/painel.js";
import { rotasPublicas } from "./rotas/publicas.js";
import { rotasRegistros } from "./rotas/registros.js";
import { rotasTarefas } from "./rotas/tarefas.js";

/**
 * Monta a API. Tudo fica sob /api: a interface web faz proxy desse prefixo,
 * então navegador e API compartilham a mesma origem (sem CORS, cookie Strict).
 */
export function criarApp(deps: Deps) {
  const { ctx } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", ctx.ambiente.CONFIAR_PROXY);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ erro: { codigo: "muitas_requisicoes", mensagem: "Muitas requisições seguidas. Aguarde um minuto." } }),
    }),
  );

  const api = Router();
  // Rotas com corpo bruto (webhook) vêm antes do parser de JSON.
  api.use(rotasPublicas(deps));
  api.use(express.json({ limit: "1mb" }));
  api.use(cookieParser());
  api.use(rotasAuth(deps));
  api.use(rotasFala(deps));

  const protegida = Router();
  protegida.use(exigirLogin(deps));
  protegida.use(rotasRegistros(deps));
  protegida.use(rotasPainel(deps));
  protegida.use(rotasTarefas(deps));
  protegida.use(rotasAgenda(deps));
  api.use(protegida);

  api.use((_req, res) => {
    res.status(404).json({ erro: { codigo: "nao_encontrado", mensagem: "Rota não encontrada." } });
  });

  app.use("/api", api);
  app.use(tratarErros(ctx));
  return app;
}
