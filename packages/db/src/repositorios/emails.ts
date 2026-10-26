import type { Executor } from "../conexao.js";

export type AcaoEmail = "ignorado" | "tarefa" | "registro";

export interface EmailLinha {
  id: string;
  chave: string;
  remetente: string;
  assunto: string;
  recebidoEm: Date;
  trecho: string;
  texto: string;
  acao: AcaoEmail | null;
  /** Resultado da IA em fontes_processadas: registro | irrelevante | erro | null (ainda não leu). */
  resultadoIa: string | null;
  registroId: string | null;
  registroCodigo: string | null;
  registroTitulo: string | null;
  registroStatus: string | null;
  tarefaId: string | null;
  tarefaCodigo: string | null;
  tarefaTitulo: string | null;
  tarefaStatus: string | null;
}

export interface NovoEmail {
  chave: string;
  remetente: string;
  assunto: string;
  recebidoEm: Date | null;
  texto: string;
}

const SELECAO = `
  SELECT e.id, e.chave, e.remetente, e.assunto, coalesce(e.recebido_em, e.criado_em) AS "recebidoEm",
         e.trecho, e.texto, e.acao, fp.resultado AS "resultadoIa",
         r.id AS "registroId", r.codigo AS "registroCodigo", r.titulo AS "registroTitulo", r.status AS "registroStatus",
         t.id AS "tarefaId", t.codigo AS "tarefaCodigo", t.titulo AS "tarefaTitulo", t.status AS "tarefaStatus"
    FROM cerebro.emails e
    LEFT JOIN cerebro.fontes_processadas fp ON fp.chave = e.chave
    LEFT JOIN cerebro.registros r ON r.id = coalesce(e.registro_id, fp.registro_id)
    LEFT JOIN cerebro.tarefas t ON t.id = e.tarefa_id`;

/** Pendente = precisa de alguém: chegou e ninguém decidiu, ou virou rascunho que ainda não foi revisado. */
const PENDENTE = `(e.acao IS NULL AND (fp.resultado IS NULL OR fp.resultado = 'erro' OR (fp.resultado = 'registro' AND r.status = 'rascunho')))`;

export const emails = {
  async guardar(db: Executor, e: NovoEmail) {
    const texto = e.texto.slice(0, 60_000);
    const trecho = texto.replace(/\s+/g, " ").trim().slice(0, 280);
    await db.query(
      `INSERT INTO cerebro.emails (chave, remetente, assunto, recebido_em, trecho, texto)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (chave) DO NOTHING`,
      [e.chave, e.remetente.slice(0, 300), e.assunto.slice(0, 500), e.recebidoEm, trecho, texto],
    );
  },

  async listar(db: Executor, filtro: "todos" | "pendentes" | "registro" | "ignorados" = "todos", limite = 100) {
    const onde =
      filtro === "pendentes"
        ? `WHERE ${PENDENTE}`
        : filtro === "registro"
          ? `WHERE (e.acao = 'registro' OR (e.acao IS NULL AND fp.resultado = 'registro'))`
          : filtro === "ignorados"
            ? `WHERE (e.acao = 'ignorado' OR (e.acao IS NULL AND fp.resultado = 'irrelevante'))`
            : "";
    const { rows } = await db.query<EmailLinha>(`${SELECAO} ${onde} ORDER BY coalesce(e.recebido_em, e.criado_em) DESC LIMIT $1`, [limite]);
    return rows;
  },

  async contarPendentes(db: Executor) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM cerebro.emails e
         LEFT JOIN cerebro.fontes_processadas fp ON fp.chave = e.chave
         LEFT JOIN cerebro.registros r ON r.id = coalesce(e.registro_id, fp.registro_id)
        WHERE ${PENDENTE}`,
    );
    return rows[0]?.n ?? 0;
  },

  async buscar(db: Executor, id: string) {
    const { rows } = await db.query<EmailLinha>(`${SELECAO} WHERE e.id = $1`, [id]);
    return rows[0] ?? null;
  },

  async decidir(db: Executor, id: string, acao: AcaoEmail | null, por: string | null, ligacao: { tarefaId?: string | null; registroId?: string | null } = {}) {
    await db.query(
      `UPDATE cerebro.emails
          SET acao = $2, acao_por = $3, acao_em = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
              tarefa_id = coalesce($4, tarefa_id), registro_id = coalesce($5, registro_id)
        WHERE id = $1`,
      [id, acao, por, ligacao.tarefaId ?? null, ligacao.registroId ?? null],
    );
  },
};
