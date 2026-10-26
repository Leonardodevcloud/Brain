import pg from "pg";
import { PAPEL_LEITURA, SCHEMA_ARGOS } from "./politica.js";

export type PoolLeitura = pg.Pool;

/** Mesma URL do banco, trocando usuário e senha pelos do Argos. */
export function criarPoolLeitura(urlBanco: string, senha: string, ssl = false): PoolLeitura {
  const url = new URL(urlBanco);
  url.username = PAPEL_LEITURA;
  url.password = senha;
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 3,
    idleTimeoutMillis: 30_000,
    application_name: "cerebro-argos",
    statement_timeout: 15_000,
  });
}

export interface ResultadoConsulta {
  colunas: string[];
  linhas: Record<string, unknown>[];
  /** Houve mais linhas que o limite. */
  cortado: boolean;
  ms: number;
}

const PROIBIDAS =
  /\b(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|vacuum|analyze|cluster|reindex|lock|listen|notify|call|do|execute|prepare|deallocate|set|reset|discard|comment|security|refresh|import)\b/i;
const FUNCOES_PERIGOSAS = /\b(pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink|pg_terminate_backend|pg_cancel_backend|set_config|current_setting)\s*\(/i;

/**
 * Confere o SQL escrito pela IA. É a segunda barreira: a primeira é o próprio banco
 * (usuário só leitura, só com as views do Argos, com limite de tempo).
 */
export function validarSql(sql: string): string {
  const limpo = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  if (!limpo) throw new Error("Consulta vazia.");
  if (limpo.includes(";")) throw new Error("Só uma consulta por vez.");
  if (!/^(select|with)\b/i.test(limpo)) throw new Error("Só consultas de leitura (SELECT).");
  // Remove textos entre aspas antes de procurar comandos proibidos ("pedido cancelado" não é DELETE).
  const semTextos = limpo.replace(/'(?:[^']|'')*'/g, "''");
  const proibida = semTextos.match(PROIBIDAS);
  if (proibida) throw new Error(`Comando não permitido na consulta: ${proibida[0]}.`);
  if (FUNCOES_PERIGOSAS.test(semTextos)) throw new Error("Função não permitida na consulta.");
  if (/\b(pg_\w+|information_schema|public|cerebro)\b/i.test(semTextos)) {
    throw new Error(`Use só as tabelas do schema ${SCHEMA_ARGOS}.`);
  }
  return limpo;
}

/** Executa uma consulta já validada, só leitura, com limite de linhas e de tempo. */
export async function consultar(
  pool: PoolLeitura,
  sql: string,
  params: unknown[] = [],
  { limite = 500, timeoutMs = 15_000 }: { limite?: number; timeoutMs?: number } = {},
): Promise<ResultadoConsulta> {
  const cliente = await pool.connect();
  const inicio = performance.now();
  try {
    await cliente.query("BEGIN READ ONLY");
    await cliente.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    await cliente.query(`SET LOCAL search_path = ${SCHEMA_ARGOS}`);
    const r = await cliente.query({ text: `SELECT * FROM (${sql}) AS consulta LIMIT ${limite + 1}`, values: params });
    await cliente.query("COMMIT");
    const cortado = r.rows.length > limite;
    return {
      colunas: r.fields.map((f) => f.name),
      linhas: cortado ? r.rows.slice(0, limite) : r.rows,
      cortado,
      ms: Math.round(performance.now() - inicio),
    };
  } catch (erro) {
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
}
