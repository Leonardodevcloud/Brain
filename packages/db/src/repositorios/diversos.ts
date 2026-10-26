import type { Executor } from "../conexao.js";

export type Canal = "web" | "mcp" | "worker" | "webhook";

export const auditoria = {
  async registrar(
    db: Executor,
    e: {
      usuarioId: string | null;
      canal: Canal;
      acao: string;
      entidade?: string;
      entidadeId?: string;
      detalhes?: Record<string, unknown>;
      ip?: string | null;
    },
  ) {
    await db.query(
      `INSERT INTO cerebro.auditoria (usuario_id, canal, acao, entidade, entidade_id, detalhes, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [e.usuarioId, e.canal, e.acao, e.entidade ?? null, e.entidadeId ?? null, JSON.stringify(e.detalhes ?? {}), e.ip ?? null],
    );
  },

  async porEntidade(db: Executor, entidade: string, entidadeId: string, limite = 50) {
    const { rows } = await db.query<{ criadoEm: Date; acao: string; usuario: string | null; canal: Canal; detalhes: Record<string, unknown> }>(
      `SELECT a.criado_em AS "criadoEm", a.acao, u.nome AS usuario, a.canal, a.detalhes
         FROM cerebro.auditoria a LEFT JOIN cerebro.usuarios u ON u.id = a.usuario_id
        WHERE a.entidade = $1 AND a.entidade_id = $2
        ORDER BY a.criado_em DESC LIMIT $3`,
      [entidade, entidadeId, limite],
    );
    return rows;
  },

  async recentes(db: Executor, limite = 10) {
    const { rows } = await db.query<{
      criadoEm: Date;
      acao: string;
      canal: Canal;
      usuario: string | null;
      entidadeId: string | null;
      detalhes: Record<string, unknown>;
    }>(
      `SELECT a.criado_em AS "criadoEm", a.acao, a.canal, u.nome AS usuario,
              a.entidade_id AS "entidadeId", a.detalhes
         FROM cerebro.auditoria a
         LEFT JOIN cerebro.usuarios u ON u.id = a.usuario_id
        WHERE a.acao NOT LIKE 'consulta.%' AND a.acao NOT LIKE 'auth.%'
        ORDER BY a.criado_em DESC
        LIMIT $1`,
      [limite],
    );
    return rows;
  },
};

export const lacunas = {
  async registrar(db: Executor, pergunta: string, usuarioId: string | null, canal: Canal) {
    await db.query(`INSERT INTO cerebro.lacunas (pergunta, usuario_id, canal) VALUES ($1, $2, $3)`, [
      pergunta,
      usuarioId,
      canal,
    ]);
  },

  async listarAbertas(db: Executor, limite = 50) {
    const { rows } = await db.query<{ id: string; pergunta: string; criadoEm: Date; canal: Canal }>(
      `SELECT id, pergunta, criado_em AS "criadoEm", canal
         FROM cerebro.lacunas WHERE resolvida_em IS NULL
        ORDER BY criado_em DESC LIMIT $1`,
      [limite],
    );
    return rows;
  },

  async resolver(db: Executor, id: string, registroId: string | null) {
    await db.query(`UPDATE cerebro.lacunas SET resolvida_em = now(), registro_id = $2 WHERE id = $1`, [id, registroId]);
  },
};

export interface ReuniaoLinha {
  id: string;
  origem: string;
  externoId: string;
  titulo: string;
  inicio: Date | null;
  duracaoSeg: number | null;
  url: string | null;
  transcricao: string;
  ataId: string | null;
}

export const reunioes = {
  /** Insere uma reunião recebida; devolve `null` se ela já tinha chegado antes (webhook repetido). */
  async inserirSeNova(db: Executor, r: Omit<ReuniaoLinha, "id" | "ataId">) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cerebro.reunioes (origem, externo_id, titulo, inicio, duracao_seg, url, transcricao)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (origem, externo_id) DO NOTHING
       RETURNING id`,
      [r.origem, r.externoId, r.titulo, r.inicio, r.duracaoSeg, r.url, r.transcricao],
    );
    return rows[0]?.id ?? null;
  },

  async buscarPorId(db: Executor, id: string) {
    const { rows } = await db.query<ReuniaoLinha>(
      `SELECT id, origem, externo_id AS "externoId", titulo, inicio, duracao_seg AS "duracaoSeg", url,
              transcricao, ata_id AS "ataId"
         FROM cerebro.reunioes WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  },

  async vincularAta(db: Executor, id: string, ataId: string) {
    await db.query(`UPDATE cerebro.reunioes SET ata_id = $2 WHERE id = $1`, [id, ataId]);
  },

  async ultima(db: Executor) {
    const { rows } = await db.query<{ criadoEm: Date }>(
      `SELECT criado_em AS "criadoEm" FROM cerebro.reunioes ORDER BY criado_em DESC LIMIT 1`,
    );
    return rows[0]?.criadoEm ?? null;
  },
};

export const fontesProcessadas = {
  async jaProcessadas(db: Executor, chaves: string[]) {
    if (chaves.length === 0) return new Set<string>();
    const { rows } = await db.query<{ chave: string }>(
      `SELECT chave FROM cerebro.fontes_processadas WHERE chave = ANY($1::text[])`,
      [chaves],
    );
    return new Set(rows.map((r) => r.chave));
  },

  async marcar(db: Executor, chave: string, resultado: "registro" | "irrelevante" | "erro", registroId: string | null = null) {
    await db.query(
      `INSERT INTO cerebro.fontes_processadas (chave, resultado, registro_id) VALUES ($1, $2, $3)
       ON CONFLICT (chave) DO UPDATE SET resultado = $2, registro_id = $3, processado_em = now()`,
      [chave, resultado, registroId],
    );
  },
};

export const integracoes = {
  async obter(db: Executor, nome: string) {
    const { rows } = await db.query<{ config: Record<string, unknown>; segredo: string | null; atualizadoEm: Date }>(
      `SELECT config, segredo, atualizado_em AS "atualizadoEm" FROM cerebro.integracoes WHERE nome = $1`,
      [nome],
    );
    return rows[0] ?? null;
  },

  async salvar(db: Executor, nome: string, dados: { config?: Record<string, unknown>; segredo?: string | null }) {
    await db.query(
      `INSERT INTO cerebro.integracoes (nome, config, segredo) VALUES ($1, coalesce($2, '{}'::jsonb), $3)
       ON CONFLICT (nome) DO UPDATE SET
         config = coalesce($2, cerebro.integracoes.config),
         segredo = CASE WHEN $4 THEN $3 ELSE cerebro.integracoes.segredo END,
         atualizado_em = now()`,
      [nome, dados.config ? JSON.stringify(dados.config) : null, dados.segredo ?? null, dados.segredo !== undefined],
    );
  },
};
