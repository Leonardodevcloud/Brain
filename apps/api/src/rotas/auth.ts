import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "@cerebro/core";
import { acesso } from "@cerebro/servicos";
type ResultadoLogin = acesso.ResultadoLogin;
import { z } from "zod";
import { ator, exigirLogin, validar, type Deps } from "../http/base.js";

export const COOKIE_SESSAO = "cerebro_sessao";
const CAMINHO_COOKIE = "/api/auth";

const esquemaEntrar = z.object({
  email: z.email().max(200),
  senha: z.string().min(1).max(200),
});

const esquemaTrocarSenha = z.object({
  atual: z.string().min(1).max(200),
  nova: z.string().min(1).max(200),
});

/**
 * Login próprio: token de acesso curto no corpo (fica só na memória da página)
 * e refresh token num cookie httpOnly, SameSite=Strict, restrito a /api/auth.
 */
export function rotasAuth(deps: Deps) {
  const { ctx, emissor } = deps;
  const r = Router();
  const producao = ctx.ambiente.NODE_ENV === "production";

  const limiteEntrada = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        erro: { codigo: "muitas_tentativas", mensagem: "Muitas tentativas de entrada. Aguarde 15 minutos e tente de novo." },
      }),
  });

  function gravarCookie(res: Response, login: ResultadoLogin) {
    res.cookie(COOKIE_SESSAO, login.refreshToken, {
      httpOnly: true,
      secure: producao,
      sameSite: "strict",
      path: CAMINHO_COOKIE,
      expires: login.expiraEm,
    });
  }

  /** Requisições que usam o cookie precisam vir da própria interface. */
  function conferirOrigem(req: Request) {
    const origem = req.get("origin");
    if (origem && origem !== new URL(ctx.ambiente.URL_WEB).origin) throw AppError.semPermissao("Origem não permitida.");
  }

  r.post("/auth/entrar", limiteEntrada, async (req, res) => {
    conferirOrigem(req);
    const dados = validar(esquemaEntrar, req.body);
    const login = await acesso.entrar(ctx, emissor, { ...dados, ip: req.ip ?? null, userAgent: req.get("user-agent") ?? null });
    gravarCookie(res, login);
    res.json({ usuario: login.usuario, tokenAcesso: login.tokenAcesso });
  });

  r.post("/auth/renovar", async (req, res) => {
    conferirOrigem(req);
    const token = req.cookies?.[COOKIE_SESSAO] as string | undefined;
    if (!token) throw AppError.naoAutenticado();
    try {
      const login = await acesso.renovarSessao(ctx, emissor, token);
      gravarCookie(res, login);
      res.json({ usuario: login.usuario, tokenAcesso: login.tokenAcesso });
    } catch (erro) {
      res.clearCookie(COOKIE_SESSAO, { path: CAMINHO_COOKIE });
      throw erro;
    }
  });

  r.post("/auth/sair", async (req, res) => {
    conferirOrigem(req);
    await acesso.sair(ctx, req.cookies?.[COOKIE_SESSAO] as string | undefined);
    res.clearCookie(COOKIE_SESSAO, { path: CAMINHO_COOKIE });
    res.status(204).end();
  });

  r.get("/eu", exigirLogin(deps), async (req, res) => {
    res.json(await acesso.obterUsuario(ctx, ator(req).usuarioId!));
  });

  r.post("/eu/senha", exigirLogin(deps), async (req, res) => {
    const { atual, nova } = validar(esquemaTrocarSenha, req.body);
    await acesso.trocarSenha(ctx, ator(req), atual, nova);
    res.clearCookie(COOKIE_SESSAO, { path: CAMINHO_COOKIE });
    res.status(204).end();
  });

  return r;
}
