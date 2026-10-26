import type { Pool } from "@cerebro/db";
import { PAPEL_LEITURA, SCHEMA_ARGOS, ehColunaPessoal, tabelaLiberada } from "./politica.js";

const ident = (nome: string) => `"${nome.replaceAll('"', '""')}"`;

export interface ResultadoSincronizacao {
  tabelas: number;
  colunasOcultas: number;
  tabelasBloqueadas: string[];
}

/**
 * Monta (ou atualiza) o acesso do Argos à Central, com a conexão DONA do banco:
 *  - usuário `argos_leitura`, só leitura, com limite de tempo por consulta;
 *  - schema `argos` com uma view por tabela da Central, sem as colunas pessoais;
 *  - o usuário só enxerga essas views (nada do schema public, nada do Cérebro).
 * É idempotente: roda ao subir a API e toda madrugada, para pegar tabelas e colunas novas.
 */
export async function sincronizarAcesso(dono: Pool, senha: string): Promise<ResultadoSincronizacao> {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(senha)) {
    throw new Error("ARGOS_DB_SENHA precisa de 24+ caracteres (letras, números, _ ou -).");
  }

  const { rows: colunas } = await dono.query<{ tabela: string; coluna: string }>(
    `SELECT c.table_name AS tabela, c.column_name AS coluna
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const porTabela = new Map<string, string[]>();
  for (const c of colunas) porTabela.set(c.tabela, [...(porTabela.get(c.tabela) ?? []), c.coluna]);

  const cliente = await dono.connect();
  let ocultas = 0;
  const bloqueadas: string[] = [];
  let criadas = 0;
  try {
    await cliente.query("BEGIN");
    await cliente.query("SELECT pg_advisory_xact_lock(hashtext('cerebro.argos_sincronizar'))");

    const { rowCount } = await cliente.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [PAPEL_LEITURA]);
    // A senha não aceita parâmetro em CREATE/ALTER ROLE; ela foi validada acima (só [A-Za-z0-9_-]).
    if (rowCount) await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} WITH LOGIN PASSWORD '${senha}'`);
    else await cliente.query(`CREATE ROLE ${PAPEL_LEITURA} WITH LOGIN PASSWORD '${senha}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} CONNECTION LIMIT 5`);
    await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} SET default_transaction_read_only = on`);
    await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} SET statement_timeout = '15s'`);
    await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} SET idle_in_transaction_session_timeout = '30s'`);
    await cliente.query(`ALTER ROLE ${PAPEL_LEITURA} SET search_path = ${SCHEMA_ARGOS}`);

    // Começa do zero: as views refletem exatamente as tabelas e colunas de agora.
    await cliente.query(`DROP SCHEMA IF EXISTS ${SCHEMA_ARGOS} CASCADE`);
    await cliente.query(`CREATE SCHEMA ${SCHEMA_ARGOS}`);
    await cliente.query(`REVOKE ALL ON SCHEMA public FROM ${PAPEL_LEITURA}`);
    await cliente.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${PAPEL_LEITURA}`);
    await cliente.query(`REVOKE ALL ON SCHEMA cerebro FROM ${PAPEL_LEITURA}`).catch(() => undefined);

    for (const [tabela, cols] of porTabela) {
      if (!tabelaLiberada(tabela)) {
        bloqueadas.push(tabela);
        continue;
      }
      const visiveis = cols.filter((c) => !ehColunaPessoal(c));
      ocultas += cols.length - visiveis.length;
      if (!visiveis.length) continue;
      // security_barrier: o planejador não "vaza" linhas por funções do usuário.
      await cliente.query(
        `CREATE VIEW ${SCHEMA_ARGOS}.${ident(tabela)} WITH (security_barrier = true) AS
           SELECT ${visiveis.map(ident).join(", ")} FROM public.${ident(tabela)}`,
      );
      criadas++;
    }
    await cliente.query(`GRANT USAGE ON SCHEMA ${SCHEMA_ARGOS} TO ${PAPEL_LEITURA}`);
    await cliente.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA_ARGOS} TO ${PAPEL_LEITURA}`);
    await cliente.query("COMMIT");
  } catch (erro) {
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw erro;
  } finally {
    cliente.release();
  }
  return { tabelas: criadas, colunasOcultas: ocultas, tabelasBloqueadas: bloqueadas };
}
