import type { Executor } from "../conexao.js";

export interface SessaoLinha {
  id: string;
  usuarioId: string;
  expiraEm: Date;
}

export const sessoes = {
  async criar(db: Executor, dados: { usuarioId: string; tokenHash: string; expiraEm: Date; userAgent?: string | null }) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cerebro.sessoes (usuario_id, token_hash, expira_em, user_agent)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [dados.usuarioId, dados.tokenHash, dados.expiraEm, dados.userAgent ?? null],
    );
    return rows[0]!.id;
  },

  /** Sessão ainda válida (não expirada, não revogada) para o hash do refresh token. */
  async buscarValida(db: Executor, tokenHash: string) {
    const { rows } = await db.query<SessaoLinha>(
      `SELECT id, usuario_id AS "usuarioId", expira_em AS "expiraEm"
         FROM cerebro.sessoes
        WHERE token_hash = $1 AND revogada_em IS NULL AND expira_em > now()`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  async revogar(db: Executor, id: string) {
    await db.query(`UPDATE cerebro.sessoes SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL`, [id]);
  },

  async revogarTodas(db: Executor, usuarioId: string) {
    await db.query(`UPDATE cerebro.sessoes SET revogada_em = now() WHERE usuario_id = $1 AND revogada_em IS NULL`, [
      usuarioId,
    ]);
  },
};

export interface TokenConectorLinha {
  id: string;
  usuarioId: string;
  nome: string;
  prefixo: string;
  ultimoUsoEm: Date | null;
  criadoEm: Date;
}

export const tokensConector = {
  async criar(db: Executor, dados: { usuarioId: string; nome: string; prefixo: string; tokenHash: string }) {
    const { rows } = await db.query<TokenConectorLinha>(
      `INSERT INTO cerebro.tokens_conector (usuario_id, nome, prefixo, token_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, usuario_id AS "usuarioId", nome, prefixo, ultimo_uso_em AS "ultimoUsoEm", criado_em AS "criadoEm"`,
      [dados.usuarioId, dados.nome, dados.prefixo, dados.tokenHash],
    );
    return rows[0]!;
  },

  /** Token ativo de um usuário ativo; atualiza o último uso no mesmo comando. */
  async usar(db: Executor, tokenHash: string) {
    const { rows } = await db.query<{ usuarioId: string }>(
      `UPDATE cerebro.tokens_conector t
          SET ultimo_uso_em = now()
         FROM cerebro.usuarios u
        WHERE t.token_hash = $1 AND t.revogado_em IS NULL
          AND u.id = t.usuario_id AND u.ativo
        RETURNING t.usuario_id AS "usuarioId"`,
      [tokenHash],
    );
    return rows[0]?.usuarioId ?? null;
  },

  async listarDoUsuario(db: Executor, usuarioId: string) {
    const { rows } = await db.query<TokenConectorLinha>(
      `SELECT id, usuario_id AS "usuarioId", nome, prefixo, ultimo_uso_em AS "ultimoUsoEm", criado_em AS "criadoEm"
         FROM cerebro.tokens_conector
        WHERE usuario_id = $1 AND revogado_em IS NULL
        ORDER BY criado_em DESC`,
      [usuarioId],
    );
    return rows;
  },

  async revogar(db: Executor, id: string, usuarioId: string) {
    const { rowCount } = await db.query(
      `UPDATE cerebro.tokens_conector SET revogado_em = now()
        WHERE id = $1 AND usuario_id = $2 AND revogado_em IS NULL`,
      [id, usuarioId],
    );
    return (rowCount ?? 0) > 0;
  },
};
