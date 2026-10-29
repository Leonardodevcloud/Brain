import type { Executor } from "../conexao.js";

export interface ResumoConversaLinha {
  id: string;
  titulo: string;
  trocas: number;
  atualizadoEm: Date;
}
export interface ConversaLinha extends ResumoConversaLinha {
  turnos: unknown[];
}

/** Conversas do Argos: cada pessoa só lê, grava e apaga as suas. */
export const conversas = {
  async listar(db: Executor, usuarioId: string, busca?: string, limite = 60) {
    const termo = busca?.trim() ? `%${busca.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const { rows } = await db.query<ResumoConversaLinha>(
      `SELECT id, titulo, jsonb_array_length(turnos) AS trocas, atualizado_em AS "atualizadoEm"
         FROM cerebro.conversas
        WHERE usuario_id = $1 AND ($2::text IS NULL OR titulo ILIKE $2 OR texto ILIKE $2)
        ORDER BY atualizado_em DESC
        LIMIT $3`,
      [usuarioId, termo, limite],
    );
    return rows;
  },

  async buscar(db: Executor, usuarioId: string, id: string) {
    const { rows } = await db.query<ConversaLinha>(
      `SELECT id, titulo, turnos, jsonb_array_length(turnos) AS trocas, atualizado_em AS "atualizadoEm"
         FROM cerebro.conversas WHERE id = $1 AND usuario_id = $2`,
      [id, usuarioId],
    );
    return rows[0] ?? null;
  },

  /** Cria ou substitui a conversa (só se for do mesmo dono). Devolve false se o id é de outra pessoa. */
  async gravar(db: Executor, usuarioId: string, c: { id: string; titulo: string; turnos: unknown[]; texto: string }) {
    const { rowCount } = await db.query(
      `INSERT INTO cerebro.conversas (id, usuario_id, titulo, turnos, texto)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE
          SET titulo = EXCLUDED.titulo, turnos = EXCLUDED.turnos, texto = EXCLUDED.texto, atualizado_em = now()
        WHERE cerebro.conversas.usuario_id = EXCLUDED.usuario_id`,
      [c.id, usuarioId, c.titulo, JSON.stringify(c.turnos), c.texto],
    );
    return (rowCount ?? 0) > 0;
  },

  async apagar(db: Executor, usuarioId: string, id: string) {
    const { rowCount } = await db.query(`DELETE FROM cerebro.conversas WHERE id = $1 AND usuario_id = $2`, [id, usuarioId]);
    return (rowCount ?? 0) > 0;
  },
};
