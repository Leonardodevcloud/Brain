import type { Papel } from "@cerebro/core";
import type { Executor } from "../conexao.js";

export interface UsuarioLinha {
  id: string;
  nome: string;
  email: string;
  senhaHash: string;
  papel: Papel;
  ativo: boolean;
}

const COLUNAS = `id, nome, email, senha_hash AS "senhaHash", papel, ativo`;

export const usuarios = {
  async buscarPorEmail(db: Executor, email: string) {
    const { rows } = await db.query<UsuarioLinha>(
      `SELECT ${COLUNAS} FROM cerebro.usuarios WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  },

  async buscarPorId(db: Executor, id: string) {
    const { rows } = await db.query<UsuarioLinha>(`SELECT ${COLUNAS} FROM cerebro.usuarios WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listar(db: Executor) {
    const { rows } = await db.query<Omit<UsuarioLinha, "senhaHash">>(
      `SELECT id, nome, email, papel, ativo FROM cerebro.usuarios ORDER BY nome`,
    );
    return rows;
  },

  async criar(db: Executor, dados: { nome: string; email: string; senhaHash: string; papel: Papel }) {
    const { rows } = await db.query<UsuarioLinha>(
      `INSERT INTO cerebro.usuarios (nome, email, senha_hash, papel)
       VALUES ($1, lower($2), $3, $4)
       RETURNING ${COLUNAS}`,
      [dados.nome, dados.email, dados.senhaHash, dados.papel],
    );
    return rows[0]!;
  },

  async atualizarSenha(db: Executor, id: string, senhaHash: string) {
    await db.query(`UPDATE cerebro.usuarios SET senha_hash = $2, atualizado_em = now() WHERE id = $1`, [
      id,
      senhaHash,
    ]);
  },

  async definirAtivo(db: Executor, id: string, ativo: boolean) {
    await db.query(`UPDATE cerebro.usuarios SET ativo = $2, atualizado_em = now() WHERE id = $1`, [id, ativo]);
  },
};
