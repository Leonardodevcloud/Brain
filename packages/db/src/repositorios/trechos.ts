import type { Area, StatusRegistro, TipoRegistro } from "@cerebro/core";
import type { Executor } from "../conexao.js";

export interface TrechoComVetor {
  id: string;
  registroId: string;
  texto: string;
  embedding: number[];
}

export interface FiltroBusca {
  statusIn: StatusRegistro[];
  tipo?: TipoRegistro;
  area?: Area;
  clienteRef?: string;
  /** Restritos ficam de fora de tudo que vai para IA externa sem provedor seguro. */
  incluirRestritos: boolean;
}

function montarFiltro(f: FiltroBusca, params: unknown[]) {
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const condicoes = [`r.status = ANY(${p(f.statusIn)}::text[])`];
  if (f.tipo) condicoes.push(`r.tipo = ${p(f.tipo)}`);
  if (f.area) condicoes.push(`r.area = ${p(f.area)}`);
  if (f.clienteRef) condicoes.push(`r.cliente_ref ILIKE ${p(f.clienteRef)}`);
  if (!f.incluirRestritos) condicoes.push(`r.confidencialidade = 'interno'`);
  return condicoes.join(" AND ");
}

export const trechos = {
  /** Troca todos os trechos de um registro de uma vez (reindexação). */
  async substituir(
    db: Executor,
    registroId: string,
    novos: { texto: string; embedding: number[] | null }[],
    modelo: string | null,
  ) {
    await db.query(`DELETE FROM cerebro.trechos WHERE registro_id = $1`, [registroId]);
    for (const [ordem, t] of novos.entries()) {
      await db.query(
        `INSERT INTO cerebro.trechos (registro_id, ordem, texto, embedding, modelo) VALUES ($1, $2, $3, $4, $5)`,
        [registroId, ordem, t.texto, t.embedding, t.embedding ? modelo : null],
      );
    }
  },

  async listarComVetor(db: Executor, filtro: FiltroBusca): Promise<TrechoComVetor[]> {
    const params: unknown[] = [];
    const where = montarFiltro(filtro, params);
    const { rows } = await db.query<TrechoComVetor>(
      `SELECT t.id, t.registro_id AS "registroId", t.texto, t.embedding
         FROM cerebro.trechos t
         JOIN cerebro.registros r ON r.id = t.registro_id
        WHERE t.embedding IS NOT NULL AND ${where}`,
      params,
    );
    return rows;
  },

  /**
   * Busca textual em português sobre título, cliente e conteúdo, com o melhor trecho destacado.
   * Perguntas em linguagem natural viram OU entre os termos: o ranking premia quem casa mais termos.
   */
  async buscarTexto(db: Executor, consulta: string, filtro: FiltroBusca, limite: number) {
    const params: unknown[] = [consulta];
    const where = montarFiltro(filtro, params);
    params.push(limite);
    const { rows } = await db.query<{ registroId: string; rank: number; trecho: string }>(
      `WITH q AS (
         SELECT to_tsquery('portuguese', replace(plainto_tsquery('portuguese', $1)::text, ' & ', ' | ')) AS consulta
       )
       SELECT r.id AS "registroId",
              ts_rank_cd(r.busca, q.consulta) AS rank,
              ts_headline('portuguese', r.conteudo, q.consulta,
                          'MaxWords=40, MinWords=15, MaxFragments=1, StartSel="", StopSel=""') AS trecho
         FROM cerebro.registros r, q
        WHERE r.busca @@ q.consulta AND ${where}
        ORDER BY rank DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows;
  },

  async contar(db: Executor) {
    const { rows } = await db.query<{ total: number; comVetor: number }>(
      `SELECT count(*)::int AS total, count(embedding)::int AS "comVetor" FROM cerebro.trechos`,
    );
    return rows[0]!;
  },
};
