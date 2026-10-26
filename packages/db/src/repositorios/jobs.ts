import type { Executor } from "../conexao.js";

export interface JobLinha {
  id: number;
  tipo: string;
  payload: Record<string, unknown>;
  tentativas: number;
  maxTentativas: number;
}

export const jobs = {
  /**
   * Coloca um job na fila. Com `chave`, ignora se já existe um pendente com a mesma chave
   * (ex.: duas edições seguidas do mesmo registro geram uma só reindexação).
   */
  async enfileirar(
    db: Executor,
    tipo: string,
    payload: Record<string, unknown>,
    opcoes: { chave?: string; executarEm?: Date; maxTentativas?: number } = {},
  ) {
    await db.query(
      `INSERT INTO cerebro.jobs (tipo, payload, chave, executar_em, max_tentativas)
       VALUES ($1, $2, $3, coalesce($4, now()), $5)
       ON CONFLICT (chave) WHERE status = 'pendente' AND chave IS NOT NULL DO NOTHING`,
      [tipo, JSON.stringify(payload), opcoes.chave ?? null, opcoes.executarEm ?? null, opcoes.maxTentativas ?? 5],
    );
  },

  /** Reserva o próximo job pronto. Vários workers podem disputar sem pegar o mesmo. */
  async reservar(db: Executor): Promise<JobLinha | null> {
    const { rows } = await db.query<JobLinha>(
      `UPDATE cerebro.jobs j
          SET status = 'executando', tentativas = j.tentativas + 1, atualizado_em = now()
        WHERE j.id = (
          SELECT id FROM cerebro.jobs
           WHERE status = 'pendente' AND executar_em <= now()
           ORDER BY executar_em
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING j.id, j.tipo, j.payload, j.tentativas, j.max_tentativas AS "maxTentativas"`,
    );
    return rows[0] ?? null;
  },

  async concluir(db: Executor, id: number) {
    await db.query(`UPDATE cerebro.jobs SET status = 'concluido', erro = NULL, atualizado_em = now() WHERE id = $1`, [
      id,
    ]);
  },

  /** Devolve para a fila com espera exponencial, ou marca como falho na última tentativa. */
  async falhar(db: Executor, job: JobLinha, erro: string) {
    const definitivo = job.tentativas >= job.maxTentativas;
    const esperaSeg = Math.min(3600, 30 * 2 ** (job.tentativas - 1));
    await db.query(
      `UPDATE cerebro.jobs
          SET status = $2, erro = $3, executar_em = now() + make_interval(secs => $4), atualizado_em = now()
        WHERE id = $1`,
      [job.id, definitivo ? "falhou" : "pendente", erro.slice(0, 2000), esperaSeg],
    );
    return definitivo;
  },

  /** Jobs presos em "executando" (worker reiniciou no meio) voltam para a fila. */
  async liberarPresos(db: Executor, minutos = 15) {
    const { rowCount } = await db.query(
      `UPDATE cerebro.jobs SET status = 'pendente', atualizado_em = now()
        WHERE status = 'executando' AND atualizado_em < now() - make_interval(mins => $1)`,
      [minutos],
    );
    return rowCount ?? 0;
  },

  async limparConcluidos(db: Executor, dias = 30) {
    await db.query(
      `DELETE FROM cerebro.jobs WHERE status = 'concluido' AND atualizado_em < now() - make_interval(days => $1)`,
      [dias],
    );
  },

  async resumo(db: Executor) {
    const { rows } = await db.query<{ status: string; total: number }>(
      `SELECT status, count(*)::int AS total FROM cerebro.jobs GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.total])) as Record<string, number>;
  },
};
