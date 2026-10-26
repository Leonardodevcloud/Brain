import type { Executor } from "../conexao.js";

export type StatusTarefa = "a_fazer" | "fazendo" | "feita";
export type OrigemTarefa = "manual" | "ata" | "argos" | "claude" | "email";

export interface TarefaLinha {
  id: string;
  codigo: string;
  titulo: string;
  descricao: string;
  status: StatusTarefa;
  ordem: number;
  responsavelId: string | null;
  responsavelNome: string | null;
  responsavelTexto: string | null;
  prazo: string | null;
  origem: OrigemTarefa;
  origemRegistroId: string | null;
  clienteRef: string | null;
  eventoId: string | null;
  eventoTitulo: string | null;
  eventoInicio: Date | null;
  eventoUrl: string | null;
  criadoPor: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
  concluidaEm: Date | null;
}

export interface LigacaoTarefa {
  tarefaId: string;
  registroId: string;
  codigo: string;
  titulo: string;
  tipo: string;
}

export interface NovaTarefa {
  titulo: string;
  descricao?: string;
  status?: StatusTarefa;
  responsavelId?: string | null;
  responsavelTexto?: string | null;
  prazo?: string | null;
  origem?: OrigemTarefa;
  origemRegistroId?: string | null;
  clienteRef?: string | null;
  criadoPor?: string | null;
}

export type CamposTarefa = Partial<{
  titulo: string;
  descricao: string;
  status: StatusTarefa;
  ordem: number;
  responsavelId: string | null;
  responsavelTexto: string | null;
  prazo: string | null;
  clienteRef: string | null;
  eventoId: string | null;
  eventoTitulo: string | null;
  eventoInicio: Date | null;
  eventoUrl: string | null;
}>;

export interface FiltroTarefas {
  status?: StatusTarefa[];
  responsavelId?: string;
  /** Só as com prazo vencido (e não feitas). */
  atrasadas?: boolean;
  /** Ligadas a este registro (como origem ou ligação). */
  registroId?: string;
  texto?: string;
  /** Feitas há no máximo N dias (as antigas somem da lista). */
  feitasDias?: number;
  limite?: number;
}

const COLUNAS = `t.id, t.codigo, t.titulo, t.descricao, t.status, t.ordem,
  t.responsavel_id AS "responsavelId", u.nome AS "responsavelNome", t.responsavel_texto AS "responsavelTexto",
  to_char(t.prazo, 'YYYY-MM-DD') AS prazo, t.origem, t.origem_registro_id AS "origemRegistroId", t.cliente_ref AS "clienteRef",
  t.evento_id AS "eventoId", t.evento_titulo AS "eventoTitulo", t.evento_inicio AS "eventoInicio", t.evento_url AS "eventoUrl",
  t.criado_por AS "criadoPor", t.criado_em AS "criadoEm", t.atualizado_em AS "atualizadoEm", t.concluida_em AS "concluidaEm"`;

const MAPA_CAMPOS: Record<keyof CamposTarefa, string> = {
  titulo: "titulo",
  descricao: "descricao",
  status: "status",
  ordem: "ordem",
  responsavelId: "responsavel_id",
  responsavelTexto: "responsavel_texto",
  prazo: "prazo",
  clienteRef: "cliente_ref",
  eventoId: "evento_id",
  eventoTitulo: "evento_titulo",
  eventoInicio: "evento_inicio",
  eventoUrl: "evento_url",
};

export const tarefas = {
  async proximoCodigo(db: Executor) {
    const { rows } = await db.query<{ numero: number }>(
      `INSERT INTO cerebro.sequencias_codigo (tipo, proximo) VALUES ('tarefa', 2)
       ON CONFLICT (tipo) DO UPDATE SET proximo = cerebro.sequencias_codigo.proximo + 1
       RETURNING proximo - 1 AS numero`,
    );
    return `TAR-${String(rows[0]!.numero).padStart(3, "0")}`;
  },

  /** Insere; numa pendência de ata repetida devolve null (já existe). */
  async inserir(db: Executor, t: NovaTarefa): Promise<string | null> {
    const codigo = await tarefas.proximoCodigo(db);
    const status = t.status ?? "a_fazer";
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cerebro.tarefas (codigo, titulo, descricao, status, ordem, responsavel_id, responsavel_texto, prazo,
                                    origem, origem_registro_id, cliente_ref, criado_por, concluida_em)
       VALUES ($1, $2, $3, $4,
               coalesce((SELECT min(ordem) FROM cerebro.tarefas WHERE status = $4), 1000) - 1,
               $5, $6, $7, $8, $9, $10, $11, CASE WHEN $4 = 'feita' THEN now() END)
       ON CONFLICT (origem_registro_id, titulo) WHERE origem = 'ata' DO NOTHING
       RETURNING id`,
      [
        codigo,
        t.titulo,
        t.descricao ?? "",
        status,
        t.responsavelId ?? null,
        t.responsavelTexto ?? null,
        t.prazo ?? null,
        t.origem ?? "manual",
        t.origemRegistroId ?? null,
        t.clienteRef ?? null,
        t.criadoPor ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  },

  async buscarPorId(db: Executor, id: string) {
    const { rows } = await db.query<TarefaLinha>(
      `SELECT ${COLUNAS} FROM cerebro.tarefas t LEFT JOIN cerebro.usuarios u ON u.id = t.responsavel_id WHERE t.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async buscarPorCodigo(db: Executor, codigo: string) {
    const { rows } = await db.query<TarefaLinha>(
      `SELECT ${COLUNAS} FROM cerebro.tarefas t LEFT JOIN cerebro.usuarios u ON u.id = t.responsavel_id WHERE t.codigo = $1`,
      [codigo],
    );
    return rows[0] ?? null;
  },

  async listar(db: Executor, f: FiltroTarefas = {}) {
    const onde: string[] = [];
    const p: unknown[] = [];
    if (f.status?.length) onde.push(`t.status = ANY($${p.push(f.status)}::text[])`);
    if (f.responsavelId) onde.push(`t.responsavel_id = $${p.push(f.responsavelId)}`);
    if (f.atrasadas) onde.push(`t.status <> 'feita' AND t.prazo < (now() AT TIME ZONE 'America/Bahia')::date`);
    if (f.registroId) {
      const i = p.push(f.registroId);
      onde.push(`(t.origem_registro_id = $${i} OR EXISTS (SELECT 1 FROM cerebro.tarefa_registros tr WHERE tr.tarefa_id = t.id AND tr.registro_id = $${i}))`);
    }
    if (f.texto) {
      const i = p.push(`%${f.texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      onde.push(`(t.titulo ILIKE $${i} OR t.codigo ILIKE $${i} OR t.cliente_ref ILIKE $${i} OR t.responsavel_texto ILIKE $${i} OR u.nome ILIKE $${i})`);
    }
    if (f.feitasDias !== undefined) onde.push(`(t.status <> 'feita' OR t.concluida_em > now() - make_interval(days => $${p.push(f.feitasDias)}))`);
    const { rows } = await db.query<TarefaLinha>(
      `SELECT ${COLUNAS} FROM cerebro.tarefas t LEFT JOIN cerebro.usuarios u ON u.id = t.responsavel_id
        ${onde.length ? `WHERE ${onde.join(" AND ")}` : ""}
        ORDER BY t.status, t.ordem, t.prazo NULLS LAST, t.criado_em
        LIMIT $${p.push(f.limite ?? 500)}`,
      p,
    );
    return rows;
  },

  async atualizar(db: Executor, id: string, campos: CamposTarefa) {
    const sets: string[] = [];
    const p: unknown[] = [id];
    for (const [k, v] of Object.entries(campos) as [keyof CamposTarefa, unknown][]) {
      if (v === undefined || !MAPA_CAMPOS[k]) continue;
      sets.push(`${MAPA_CAMPOS[k]} = $${p.push(v)}`);
    }
    if (campos.status !== undefined) sets.push(`concluida_em = CASE WHEN $${p.push(campos.status)} = 'feita' THEN coalesce(concluida_em, now()) ELSE NULL END`);
    if (!sets.length) return;
    await db.query(`UPDATE cerebro.tarefas SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`, p);
  },

  async remover(db: Executor, id: string) {
    await db.query(`DELETE FROM cerebro.tarefas WHERE id = $1`, [id]);
  },

  /** Ordem para soltar a tarefa entre duas outras do quadro. */
  async ordemEntre(db: Executor, status: StatusTarefa, antesDeId: string | null) {
    if (!antesDeId) {
      const { rows } = await db.query<{ o: number | null }>(`SELECT max(ordem) AS o FROM cerebro.tarefas WHERE status = $1`, [status]);
      return (rows[0]?.o ?? 0) + 1;
    }
    const { rows } = await db.query<{ alvo: number; anterior: number | null }>(
      `SELECT a.ordem AS alvo,
              (SELECT max(b.ordem) FROM cerebro.tarefas b WHERE b.status = $1 AND b.ordem < a.ordem) AS anterior
         FROM cerebro.tarefas a WHERE a.id = $2`,
      [status, antesDeId],
    );
    const r = rows[0];
    if (!r) return 0;
    return r.anterior === null ? r.alvo - 1 : (r.alvo + r.anterior) / 2;
  },

  async ligacoes(db: Executor, ids: string[]) {
    if (!ids.length) return [];
    const { rows } = await db.query<LigacaoTarefa>(
      `SELECT tr.tarefa_id AS "tarefaId", r.id AS "registroId", r.codigo, r.titulo, r.tipo
         FROM cerebro.tarefa_registros tr JOIN cerebro.registros r ON r.id = tr.registro_id
        WHERE tr.tarefa_id = ANY($1::uuid[])
        UNION ALL
       SELECT t.id, r.id, r.codigo, r.titulo, r.tipo
         FROM cerebro.tarefas t JOIN cerebro.registros r ON r.id = t.origem_registro_id
        WHERE t.id = ANY($1::uuid[])`,
      [ids],
    );
    return rows;
  },

  async ligar(db: Executor, tarefaId: string, registroId: string) {
    await db.query(`INSERT INTO cerebro.tarefa_registros (tarefa_id, registro_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [tarefaId, registroId]);
  },

  async desligar(db: Executor, tarefaId: string, registroId: string) {
    await db.query(`DELETE FROM cerebro.tarefa_registros WHERE tarefa_id = $1 AND registro_id = $2`, [tarefaId, registroId]);
  },

  /** Abertas por registro, para o mapa e a tela do registro. */
  async abertasPorRegistro(db: Executor) {
    const { rows } = await db.query<{ registroId: string; abertas: number }>(
      `SELECT registro_id AS "registroId", count(*)::int AS abertas FROM (
         SELECT t.origem_registro_id AS registro_id FROM cerebro.tarefas t WHERE t.status <> 'feita' AND t.origem_registro_id IS NOT NULL
         UNION ALL
         SELECT tr.registro_id FROM cerebro.tarefa_registros tr JOIN cerebro.tarefas t ON t.id = tr.tarefa_id WHERE t.status <> 'feita'
       ) x GROUP BY registro_id`,
    );
    return rows;
  },

  async contarAbertas(db: Executor, responsavelId: string | null) {
    const { rows } = await db.query<{ minhas: number; atrasadas: number; abertas: number }>(
      `SELECT count(*) FILTER (WHERE responsavel_id = $1)::int AS minhas,
              count(*) FILTER (WHERE prazo < (now() AT TIME ZONE 'America/Bahia')::date)::int AS atrasadas,
              count(*)::int AS abertas
         FROM cerebro.tarefas WHERE status <> 'feita'`,
      [responsavelId],
    );
    return rows[0]!;
  },
};
