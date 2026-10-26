import { DESCRICAO_TABELA } from "./glossario.js";
import { MODULO_DA_TABELA } from "./modulos.gerado.js";
import { SCHEMA_ARGOS } from "./politica.js";
import type { PoolLeitura } from "./leitura.js";

export interface TabelaCatalogo {
  nome: string;
  modulo: string;
  descricao: string | null;
  linhas: number;
  colunas: { nome: string; tipo: string }[];
}

let cache: { em: number; tabelas: TabelaCatalogo[] } | null = null;
const VALIDADE_MS = 10 * 60_000;

export function invalidarCatalogo() {
  cache = null;
}

/** O que o Argos enxerga da Central: as views do schema argos, com colunas e tamanho aproximado. */
export async function carregarCatalogo(pool: PoolLeitura, agora = Date.now()): Promise<TabelaCatalogo[]> {
  if (cache && agora - cache.em < VALIDADE_MS) return cache.tabelas;
  const [{ rows: colunas }, { rows: tamanhos }] = await Promise.all([
    pool.query<{ tabela: string; coluna: string; tipo: string }>(
      `SELECT table_name AS tabela, column_name AS coluna, data_type AS tipo
         FROM information_schema.columns WHERE table_schema = $1
        ORDER BY table_name, ordinal_position`,
      [SCHEMA_ARGOS],
    ),
    // Estimativa do planejador sobre a tabela original (rápida, sem contar linha a linha).
    pool.query<{ tabela: string; linhas: string }>(
      `SELECT c.relname AS tabela, GREATEST(c.reltuples, 0)::bigint AS linhas
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'`,
    ),
  ]);
  const tamanho = new Map(tamanhos.map((t) => [t.tabela, Number(t.linhas)]));
  const mapa = new Map<string, TabelaCatalogo>();
  for (const c of colunas) {
    let t = mapa.get(c.tabela);
    if (!t) {
      t = {
        nome: c.tabela,
        modulo: MODULO_DA_TABELA[c.tabela] ?? "outros",
        descricao: DESCRICAO_TABELA[c.tabela] ?? null,
        linhas: tamanho.get(c.tabela) ?? 0,
        colunas: [],
      };
      mapa.set(c.tabela, t);
    }
    t.colunas.push({ nome: c.coluna, tipo: abreviarTipo(c.tipo) });
  }
  const tabelas = [...mapa.values()].sort((a, b) => a.modulo.localeCompare(b.modulo) || a.nome.localeCompare(b.nome));
  cache = { em: agora, tabelas };
  return tabelas;
}

function abreviarTipo(t: string) {
  return t
    .replace("character varying", "texto")
    .replace("text", "texto")
    .replace("timestamp without time zone", "data-hora")
    .replace("timestamp with time zone", "data-hora")
    .replace("integer", "inteiro")
    .replace("bigint", "inteiro")
    .replace("numeric", "decimal")
    .replace("boolean", "sim/não")
    .replace("date", "data");
}

/** Lista curta (uma linha por tabela) para a IA escolher onde procurar. */
export function resumoDoCatalogo(tabelas: TabelaCatalogo[]): string {
  const porModulo = new Map<string, TabelaCatalogo[]>();
  for (const t of tabelas) porModulo.set(t.modulo, [...(porModulo.get(t.modulo) ?? []), t]);
  return [...porModulo]
    .map(
      ([modulo, ts]) =>
        `## ${modulo}\n` +
        ts.map((t) => `- ${t.nome} (~${t.linhas} linhas)${t.descricao ? `: ${t.descricao}` : ""}`).join("\n"),
    )
    .join("\n\n");
}

/** Colunas completas das tabelas escolhidas, para escrever o SQL. */
export function detalharTabelas(tabelas: TabelaCatalogo[], nomes: string[]): string {
  const escolhidas = tabelas.filter((t) => nomes.includes(t.nome));
  return escolhidas
    .map((t) => `### ${t.nome}${t.descricao ? ` — ${t.descricao}` : ""}\n${t.colunas.map((c) => `${c.nome} (${c.tipo})`).join(", ")}`)
    .join("\n\n");
}
