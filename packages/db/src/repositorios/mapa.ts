import type { Area, Confidencialidade, StatusRegistro, TipoRegistro, TipoRelacao } from "@cerebro/core";
import type { Executor } from "../conexao.js";

export interface NoMapaLinha {
  id: string;
  codigo: string;
  titulo: string;
  tipo: TipoRegistro;
  area: Area;
  status: StatusRegistro;
  clienteRef: string | null;
  confidencialidade: Confidencialidade;
  atualizadoEm: Date;
  /** Início do conteúdo, para a semelhança por texto quando não há embeddings. */
  amostra: string;
}

/** Leituras do grafo de conhecimento: tudo o que não foi descartado, de uma vez. */
export const mapa = {
  async nos(db: Executor) {
    const { rows } = await db.query<NoMapaLinha>(
      `SELECT id, codigo, titulo, tipo, area, status, cliente_ref AS "clienteRef", confidencialidade,
              atualizado_em AS "atualizadoEm", left(conteudo, 3000) AS amostra
         FROM cerebro.registros
        WHERE status <> 'descartado'
        ORDER BY atualizado_em DESC
        LIMIT $1`,
      [2000],
    );
    return rows;
  },

  async relacoes(db: Executor) {
    const { rows } = await db.query<{ origemId: string; destinoId: string; tipo: TipoRelacao }>(
      `SELECT rel.origem_id AS "origemId", rel.destino_id AS "destinoId", rel.tipo
         FROM cerebro.relacoes rel
         JOIN cerebro.registros o ON o.id = rel.origem_id AND o.status <> 'descartado'
         JOIN cerebro.registros d ON d.id = rel.destino_id AND d.status <> 'descartado'`,
    );
    return rows;
  },

  /** Um vetor por trecho; o serviço tira a média por registro. */
  async vetores(db: Executor) {
    const { rows } = await db.query<{ registroId: string; embedding: number[] }>(
      `SELECT t.registro_id AS "registroId", t.embedding
         FROM cerebro.trechos t
         JOIN cerebro.registros r ON r.id = t.registro_id AND r.status <> 'descartado'
        WHERE t.embedding IS NOT NULL`,
    );
    return rows;
  },
};
