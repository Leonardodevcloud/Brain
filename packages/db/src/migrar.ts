import type { Pool } from "./conexao.js";
import { MIGRACOES } from "./migracoes/index.js";

// Número fixo para o advisory lock: dois serviços subindo juntos não migram ao mesmo tempo.
const TRAVA_MIGRACAO = 72_001_984;

export interface ResultadoMigracao {
  aplicadas: string[];
}

/**
 * Aplica, em ordem, as migrations ainda não registradas em `cerebro.migracoes`.
 * Cada uma roda numa transação própria.
 */
export async function migrar(pool: Pool, migracoes = MIGRACOES): Promise<ResultadoMigracao> {
  const cliente = await pool.connect();
  const aplicadas: string[] = [];
  try {
    await cliente.query("SELECT pg_advisory_lock($1)", [TRAVA_MIGRACAO]);
    await cliente.query("CREATE SCHEMA IF NOT EXISTS cerebro");
    await cliente.query(
      `CREATE TABLE IF NOT EXISTS cerebro.migracoes (
         nome text PRIMARY KEY,
         aplicada_em timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await cliente.query<{ nome: string }>("SELECT nome FROM cerebro.migracoes");
    const jaAplicadas = new Set(rows.map((r) => r.nome));

    for (const { nome, sql } of migracoes) {
      if (jaAplicadas.has(nome)) continue;
      await cliente.query("BEGIN");
      try {
        await cliente.query(sql);
        await cliente.query("INSERT INTO cerebro.migracoes (nome) VALUES ($1)", [nome]);
        await cliente.query("COMMIT");
        aplicadas.push(nome);
      } catch (erro) {
        await cliente.query("ROLLBACK");
        throw new Error(`Falha na migration ${nome}: ${(erro as Error).message}`, { cause: erro });
      }
    }
    return { aplicadas };
  } finally {
    await cliente.query("SELECT pg_advisory_unlock($1)", [TRAVA_MIGRACAO]).catch(() => undefined);
    cliente.release();
  }
}
