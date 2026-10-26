import {
  conferirSenha,
  gerarHashSenha,
  gerarTokenConector,
  gerarTokenOpaco,
  hashFalso,
  hashToken,
  validarForcaSenha,
  type EmissorTokens,
} from "@cerebro/auth";
import { AppError, type Papel, type UsuarioDTO } from "@cerebro/core";
import { emTransacao, sessoes, tokensConector, usuarios } from "@cerebro/db";
import { auditar, type Ator, type Contexto } from "./contexto.js";

export const VALIDADE_SESSAO_DIAS = 30;

const paraDTO = (u: { id: string; nome: string; email: string; papel: Papel }): UsuarioDTO => ({
  id: u.id,
  nome: u.nome,
  email: u.email,
  papel: u.papel,
});

export interface ResultadoLogin {
  usuario: UsuarioDTO;
  tokenAcesso: string;
  refreshToken: string;
  expiraEm: Date;
}

async function abrirSessao(ctx: Contexto, emissor: EmissorTokens, u: { id: string; papel: Papel }, userAgent?: string | null) {
  const refreshToken = gerarTokenOpaco();
  const expiraEm = new Date(ctx.agora().getTime() + VALIDADE_SESSAO_DIAS * 86_400_000);
  await sessoes.criar(ctx.pool, { usuarioId: u.id, tokenHash: hashToken(refreshToken), expiraEm, userAgent });
  const tokenAcesso = await emissor.emitirAcesso({ usuarioId: u.id, papel: u.papel });
  return { refreshToken, expiraEm, tokenAcesso };
}

export async function entrar(
  ctx: Contexto,
  emissor: EmissorTokens,
  dados: { email: string; senha: string; ip?: string | null; userAgent?: string | null },
): Promise<ResultadoLogin> {
  const u = await usuarios.buscarPorEmail(ctx.pool, dados.email);
  // Compara sempre, mesmo sem usuário: o tempo de resposta não revela quais e-mails existem.
  const confere = await conferirSenha(dados.senha, u?.senhaHash ?? (await hashFalso()));
  if (!u || !confere || !u.ativo) {
    await auditar(ctx.pool, { usuarioId: u?.id ?? null, papel: "sistema", canal: "web", ip: dados.ip }, "auth.falha", undefined, {
      email: dados.email.toLowerCase(),
    });
    throw AppError.naoAutenticado("E-mail ou senha não conferem. Confira e tente de novo.");
  }
  const sessao = await abrirSessao(ctx, emissor, u, dados.userAgent);
  await auditar(ctx.pool, { usuarioId: u.id, papel: u.papel, canal: "web", ip: dados.ip }, "auth.entrada");
  return { usuario: paraDTO(u), ...sessao };
}

/** Troca o refresh token por um novo par (rotação: o antigo deixa de valer). */
export async function renovarSessao(ctx: Contexto, emissor: EmissorTokens, refreshToken: string): Promise<ResultadoLogin> {
  const sessao = await sessoes.buscarValida(ctx.pool, hashToken(refreshToken));
  if (!sessao) throw AppError.naoAutenticado();
  const u = await usuarios.buscarPorId(ctx.pool, sessao.usuarioId);
  if (!u || !u.ativo) throw AppError.naoAutenticado();
  await sessoes.revogar(ctx.pool, sessao.id);
  const nova = await abrirSessao(ctx, emissor, u);
  return { usuario: paraDTO(u), ...nova };
}

export async function sair(ctx: Contexto, refreshToken: string | undefined) {
  if (!refreshToken) return;
  const sessao = await sessoes.buscarValida(ctx.pool, hashToken(refreshToken));
  if (sessao) await sessoes.revogar(ctx.pool, sessao.id);
}

export async function obterUsuario(ctx: Contexto, id: string): Promise<UsuarioDTO> {
  const u = await usuarios.buscarPorId(ctx.pool, id);
  if (!u || !u.ativo) throw AppError.naoAutenticado();
  return paraDTO(u);
}

export async function listarUsuarios(ctx: Contexto) {
  return usuarios.listar(ctx.pool);
}

export async function criarUsuario(
  ctx: Contexto,
  ator: Ator | null,
  dados: { nome: string; email: string; senha: string; papel: Papel },
): Promise<UsuarioDTO> {
  if (ator && ator.papel !== "admin") throw AppError.semPermissao("Só o administrador cria usuários.");
  const problema = validarForcaSenha(dados.senha);
  if (problema) throw AppError.requisicaoInvalida(`Senha fraca. ${problema}`);
  if (await usuarios.buscarPorEmail(ctx.pool, dados.email)) throw AppError.conflito("Já existe um usuário com este e-mail.");
  const u = await usuarios.criar(ctx.pool, { ...dados, senhaHash: await gerarHashSenha(dados.senha) });
  if (ator) await auditar(ctx.pool, ator, "usuario.criado", { entidade: "usuario", id: u.id });
  return paraDTO(u);
}

export async function trocarSenha(ctx: Contexto, ator: Ator, atual: string, nova: string) {
  if (!ator.usuarioId) throw AppError.naoAutenticado();
  const u = await usuarios.buscarPorId(ctx.pool, ator.usuarioId);
  if (!u || !(await conferirSenha(atual, u.senhaHash))) throw AppError.requisicaoInvalida("A senha atual não confere.");
  const problema = validarForcaSenha(nova);
  if (problema) throw AppError.requisicaoInvalida(`Senha fraca. ${problema}`);
  await emTransacao(ctx.pool, async (db) => {
    await usuarios.atualizarSenha(db, u.id, await gerarHashSenha(nova));
    await sessoes.revogarTodas(db, u.id);
    await auditar(db, ator, "usuario.senha");
  });
}

// ───────────────────────────── Tokens do conector do Claude ─────────────────────────────

export async function criarTokenConector(ctx: Contexto, ator: Ator, nome: string) {
  if (!ator.usuarioId) throw AppError.naoAutenticado();
  const { token, prefixo, hash } = gerarTokenConector();
  const linha = await tokensConector.criar(ctx.pool, { usuarioId: ator.usuarioId, nome, prefixo, tokenHash: hash });
  await auditar(ctx.pool, ator, "conector.token_criado", { entidade: "token", id: linha.id });
  // O token completo só existe nesta resposta.
  return { id: linha.id, nome: linha.nome, prefixo, token };
}

export async function listarTokensConector(ctx: Contexto, ator: Ator) {
  if (!ator.usuarioId) throw AppError.naoAutenticado();
  return tokensConector.listarDoUsuario(ctx.pool, ator.usuarioId);
}

export async function revogarTokenConector(ctx: Contexto, ator: Ator, id: string) {
  if (!ator.usuarioId) throw AppError.naoAutenticado();
  if (!(await tokensConector.revogar(ctx.pool, id, ator.usuarioId))) throw AppError.naoEncontrado("O token");
  await auditar(ctx.pool, ator, "conector.token_revogado", { entidade: "token", id });
}

/** Valida o token enviado pelo Claude e devolve o ator correspondente. */
export async function autenticarConector(ctx: Contexto, token: string): Promise<Ator> {
  if (!token.startsWith("cbr_")) throw AppError.naoAutenticado("Token do conector inválido.");
  const usuarioId = await tokensConector.usar(ctx.pool, hashToken(token));
  if (!usuarioId) throw AppError.naoAutenticado("Token do conector inválido ou revogado.");
  const u = await usuarios.buscarPorId(ctx.pool, usuarioId);
  if (!u) throw AppError.naoAutenticado();
  return { usuarioId, papel: u.papel, canal: "mcp" };
}
