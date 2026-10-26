import pg from "pg";

// Datas puras (AAAA-MM-DD) chegam como texto: sem fuso horário deslocando o dia.
pg.types.setTypeParser(pg.types.builtins.DATE, (valor) => valor);
// bigint (ids de jobs e auditoria) cabe com folga em number neste volume.
pg.types.setTypeParser(pg.types.builtins.INT8, (valor) => Number(valor));

export type Pool = pg.Pool;
export type Cliente = pg.PoolClient;
/** Qualquer coisa que execute SQL: o pool ou um cliente dentro de uma transação. */
export type Executor = Pick<pg.Pool, "query">;

export interface OpcoesConexao {
  url: string;
  /** Railway expõe o Postgres pela rede privada sem TLS; pela rede pública, use `true`. */
  ssl?: boolean;
  max?: number;
  nomeAplicacao?: string;
}

export function criarPool({ url, ssl = false, max = 5, nomeAplicacao = "cerebro" }: OpcoesConexao): Pool {
  return new pg.Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max,
    application_name: nomeAplicacao,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Executa `fn` dentro de uma transação; desfaz tudo se algo lançar erro. */
export async function emTransacao<T>(pool: Pool, fn: (cliente: Cliente) => Promise<T>): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query("BEGIN");
    const resultado = await fn(cliente);
    await cliente.query("COMMIT");
    return resultado;
  } catch (erro) {
    await cliente.query("ROLLBACK");
    throw erro;
  } finally {
    cliente.release();
  }
}
