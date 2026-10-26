import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "@cerebro/core";
import type { EmissorTokens } from "@cerebro/auth";
import type { Ator, Contexto } from "@cerebro/servicos";
import { z } from "zod";

/** Dependências compartilhadas por todas as rotas. */
export interface Deps {
  ctx: Contexto;
  emissor: EmissorTokens;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ator?: Ator;
    }
  }
}

/** Valida com zod e devolve 400 com a lista de campos problemáticos. */
export function validar<T extends z.ZodType>(esquema: T, valor: unknown): z.infer<T> {
  const r = esquema.safeParse(valor);
  if (!r.success) {
    throw AppError.requisicaoInvalida(
      "Alguns campos precisam de ajuste.",
      r.error.issues.map((i) => ({ campo: i.path.join("."), mensagem: i.message })),
    );
  }
  return r.data;
}

export const esquemaId = z.object({ id: z.string().min(1).max(64) });

/** Ator autenticado da requisição. Só use em rotas atrás de `exigirLogin`. */
export function ator(req: Request): Ator {
  if (!req.ator) throw AppError.naoAutenticado();
  return req.ator;
}

export function exigirLogin({ emissor }: Deps): RequestHandler {
  return async (req, _res, next) => {
    const cabecalho = req.get("authorization") ?? "";
    const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : null;
    if (!token) return next(AppError.naoAutenticado());
    try {
      const { usuarioId, papel } = await emissor.verificarAcesso(token);
      req.ator = { usuarioId, papel, canal: "web", ip: req.ip ?? null };
      next();
    } catch {
      next(AppError.naoAutenticado("Sua sessão expirou. Entre de novo."));
    }
  };
}

export const exigirAdmin: RequestHandler = (req, _res, next) => {
  if (req.ator?.papel !== "admin") return next(AppError.semPermissao("Esta ação é só do administrador."));
  next();
};

export function tratarErros(ctx: Contexto) {
  return (erro: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (erro instanceof AppError) {
      if (erro.status >= 500) ctx.log.error({ erro, rota: req.path }, erro.message);
      return res.status(erro.status).json({ erro: { codigo: erro.codigo, mensagem: erro.message, detalhes: erro.detalhes } });
    }
    // Corpo JSON malformado ou grande demais (body-parser).
    const e = erro as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") {
      return res.status(400).json({ erro: { codigo: "json_invalido", mensagem: "O corpo da requisição não é um JSON válido." } });
    }
    if (e?.type === "entity.too.large") {
      return res.status(413).json({ erro: { codigo: "grande_demais", mensagem: "O arquivo enviado é grande demais." } });
    }
    ctx.log.error({ erro, rota: req.path }, "erro inesperado");
    res.status(500).json({ erro: { codigo: "interno", mensagem: "Algo deu errado do nosso lado. Tente de novo em instantes." } });
  };
}
