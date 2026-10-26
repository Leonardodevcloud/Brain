import type {
  Area,
  Confidencialidade,
  Empresa,
  FiltroRegistros,
  Origem,
  StatusRegistro,
  TipoRegistro,
  TipoRelacao,
} from "@cerebro/core";
import type { Executor } from "../conexao.js";

export interface RegistroLinha {
  id: string;
  codigo: string;
  tipo: TipoRegistro;
  titulo: string;
  conteudo: string;
  area: Area;
  empresa: Empresa;
  status: StatusRegistro;
  confidencialidade: Confidencialidade;
  donoId: string | null;
  donoNome: string | null;
  revisarEm: string | null;
  versao: number;
  origem: Origem;
  fonteUrl: string | null;
  clienteRef: string | null;
  dados: Record<string, unknown>;
  criadoPor: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export type NovoRegistro = Pick<
  RegistroLinha,
  | "tipo"
  | "titulo"
  | "conteudo"
  | "area"
  | "empresa"
  | "status"
  | "confidencialidade"
  | "donoId"
  | "revisarEm"
  | "origem"
  | "fonteUrl"
  | "clienteRef"
  | "dados"
  | "criadoPor"
>;

const SELECT_REGISTRO = `
  SELECT r.id, r.codigo, r.tipo, r.titulo, r.conteudo, r.area, r.empresa, r.status, r.confidencialidade,
         r.dono_id AS "donoId", u.nome AS "donoNome", r.revisar_em AS "revisarEm", r.versao, r.origem,
         r.fonte_url AS "fonteUrl", r.cliente_ref AS "clienteRef", r.dados,
         r.criado_por AS "criadoPor", r.criado_em AS "criadoEm", r.atualizado_em AS "atualizadoEm"
    FROM cerebro.registros r
    LEFT JOIN cerebro.usuarios u ON u.id = r.dono_id`;

/** Colunas editáveis: nome do campo → coluna. Nada fora desta lista entra num UPDATE. */
const COLUNAS_EDITAVEIS = {
  titulo: "titulo",
  conteudo: "conteudo",
  area: "area",
  empresa: "empresa",
  status: "status",
  confidencialidade: "confidencialidade",
  donoId: "dono_id",
  revisarEm: "revisar_em",
  clienteRef: "cliente_ref",
  dados: "dados",
  versao: "versao",
} as const;
export type CamposEditaveis = Partial<{ [K in keyof typeof COLUNAS_EDITAVEIS]: unknown }>;

export const registros = {
  /** Próximo número do código para o tipo, atômico mesmo com chamadas simultâneas. */
  async proximoNumero(db: Executor, tipo: TipoRegistro) {
    const { rows } = await db.query<{ numero: number }>(
      `INSERT INTO cerebro.sequencias_codigo (tipo, proximo) VALUES ($1, 2)
       ON CONFLICT (tipo) DO UPDATE SET proximo = cerebro.sequencias_codigo.proximo + 1
       RETURNING proximo - 1 AS numero`,
      [tipo],
    );
    return rows[0]!.numero;
  },

  async inserir(db: Executor, codigo: string, r: NovoRegistro) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO cerebro.registros
         (codigo, tipo, titulo, conteudo, area, empresa, status, confidencialidade,
          dono_id, revisar_em, origem, fonte_url, cliente_ref, dados, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        codigo,
        r.tipo,
        r.titulo,
        r.conteudo,
        r.area,
        r.empresa,
        r.status,
        r.confidencialidade,
        r.donoId,
        r.revisarEm,
        r.origem,
        r.fonteUrl,
        r.clienteRef,
        JSON.stringify(r.dados),
        r.criadoPor,
      ],
    );
    return rows[0]!.id;
  },

  async buscarPorId(db: Executor, id: string, opcoes: { travar?: boolean } = {}) {
    const sql = `${SELECT_REGISTRO} WHERE r.id = $1${opcoes.travar ? " FOR UPDATE OF r" : ""}`;
    const { rows } = await db.query<RegistroLinha>(sql, [id]);
    return rows[0] ?? null;
  },

  async buscarPorCodigo(db: Executor, codigo: string) {
    const { rows } = await db.query<RegistroLinha>(`${SELECT_REGISTRO} WHERE r.codigo = upper($1)`, [codigo]);
    return rows[0] ?? null;
  },

  async buscarPorIds(db: Executor, ids: string[]) {
    if (ids.length === 0) return [];
    const { rows } = await db.query<RegistroLinha>(`${SELECT_REGISTRO} WHERE r.id = ANY($1::uuid[])`, [ids]);
    return rows;
  },

  async listar(db: Executor, f: FiltroRegistros & { statusIn?: StatusRegistro[] }) {
    const condicoes: string[] = [];
    const params: unknown[] = [];
    const p = (valor: unknown) => {
      params.push(valor);
      return `$${params.length}`;
    };
    if (f.tipo) condicoes.push(`r.tipo = ${p(f.tipo)}`);
    if (f.area) condicoes.push(`r.area = ${p(f.area)}`);
    if (f.status) condicoes.push(`r.status = ${p(f.status)}`);
    else if (f.statusIn) condicoes.push(`r.status = ANY(${p(f.statusIn)}::text[])`);
    else condicoes.push(`r.status <> 'descartado'`);
    if (f.texto) {
      const t = p(f.texto);
      // Curingas do ILIKE digitados pela pessoa valem como texto literal.
      const literal = p(`%${f.texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      condicoes.push(
        `(r.busca @@ websearch_to_tsquery('portuguese', ${t}) OR r.codigo ILIKE ${literal} OR r.titulo ILIKE ${literal})`,
      );
    }
    const where = condicoes.length ? `WHERE ${condicoes.join(" AND ")}` : "";
    const limite = p(f.porPagina);
    const deslocamento = p((f.pagina - 1) * f.porPagina);
    const { rows } = await db.query<RegistroLinha & { total: number }>(
      `${SELECT_REGISTRO.replace("SELECT r.id", "SELECT count(*) OVER()::int AS total, r.id")}
       ${where}
       ORDER BY r.atualizado_em DESC
       LIMIT ${limite} OFFSET ${deslocamento}`,
      params,
    );
    return { itens: rows, total: rows[0]?.total ?? 0 };
  },

  async atualizar(db: Executor, id: string, campos: CamposEditaveis) {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [campo, valor] of Object.entries(campos)) {
      const coluna = COLUNAS_EDITAVEIS[campo as keyof typeof COLUNAS_EDITAVEIS];
      if (!coluna || valor === undefined) continue;
      params.push(campo === "dados" ? JSON.stringify(valor) : valor);
      sets.push(`${coluna} = $${params.length}`);
    }
    if (sets.length === 0) return;
    await db.query(`UPDATE cerebro.registros SET ${sets.join(", ")}, atualizado_em = now() WHERE id = $1`, params);
  },

  async inserirVersao(
    db: Executor,
    v: { registroId: string; versao: number; titulo: string; conteudo: string; metadados: object; motivo: string; autorId: string | null },
  ) {
    await db.query(
      `INSERT INTO cerebro.registro_versoes (registro_id, versao, titulo, conteudo, metadados, motivo, autor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [v.registroId, v.versao, v.titulo, v.conteudo, JSON.stringify(v.metadados), v.motivo, v.autorId],
    );
  },

  async listarVersoes(db: Executor, registroId: string) {
    const { rows } = await db.query<{ versao: number; motivo: string; autor: string | null; criadoEm: Date }>(
      `SELECT v.versao, v.motivo, u.nome AS autor, v.criado_em AS "criadoEm"
         FROM cerebro.registro_versoes v
         LEFT JOIN cerebro.usuarios u ON u.id = v.autor_id
        WHERE v.registro_id = $1
        ORDER BY v.versao DESC`,
      [registroId],
    );
    return rows;
  },

  async inserirRelacoes(db: Executor, origemId: string, relacoes: { destinoId: string; tipo: TipoRelacao }[]) {
    for (const rel of relacoes) {
      await db.query(
        `INSERT INTO cerebro.relacoes (origem_id, destino_id, tipo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [origemId, rel.destinoId, rel.tipo],
      );
    }
  },

  async listarRelacoes(db: Executor, registroId: string) {
    const { rows } = await db.query<{
      tipo: TipoRelacao;
      sentido: "saida" | "entrada";
      id: string;
      codigo: string;
      titulo: string;
      status: StatusRegistro;
    }>(
      `SELECT rel.tipo, 'saida' AS sentido, r.id, r.codigo, r.titulo, r.status
         FROM cerebro.relacoes rel JOIN cerebro.registros r ON r.id = rel.destino_id
        WHERE rel.origem_id = $1
       UNION ALL
       SELECT rel.tipo, 'entrada' AS sentido, r.id, r.codigo, r.titulo, r.status
         FROM cerebro.relacoes rel JOIN cerebro.registros r ON r.id = rel.origem_id
        WHERE rel.destino_id = $1`,
      [registroId],
    );
    return rows;
  },

  /** Registros que este substitui: viram obsoletos quando ele é aprovado. */
  async listarSubstituidos(db: Executor, registroId: string) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT destino_id AS id FROM cerebro.relacoes WHERE origem_id = $1 AND tipo = 'substitui'`,
      [registroId],
    );
    return rows.map((r) => r.id);
  },

  /** Vigentes com revisão vencida passam para `revisar`. Retorna os afetados. */
  async marcarVencidos(db: Executor, hoje: string) {
    const { rows } = await db.query<{ id: string; codigo: string; donoId: string | null }>(
      `UPDATE cerebro.registros SET status = 'revisar', atualizado_em = now()
        WHERE status = 'vigente' AND revisar_em IS NOT NULL AND revisar_em < $1::date
        RETURNING id, codigo, dono_id AS "donoId"`,
      [hoje],
    );
    return rows;
  },

  async listarParaRevisao(db: Executor, limite = 20) {
    const { rows } = await db.query<RegistroLinha>(
      `${SELECT_REGISTRO} WHERE r.status = 'rascunho' ORDER BY r.criado_em DESC LIMIT $1`,
      [limite],
    );
    return rows;
  },

  async listarVencidosOuProximos(db: Executor, dias: number, limite = 20) {
    const { rows } = await db.query<RegistroLinha>(
      `${SELECT_REGISTRO}
        WHERE r.status = 'revisar'
           OR (r.status = 'vigente' AND r.revisar_em IS NOT NULL AND r.revisar_em <= current_date + $1::int)
        ORDER BY r.revisar_em NULLS LAST
        LIMIT $2`,
      [dias, limite],
    );
    return rows;
  },

  async contarPorStatus(db: Executor) {
    const { rows } = await db.query<{ status: StatusRegistro; total: number }>(
      `SELECT status, count(*)::int AS total FROM cerebro.registros GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.total])) as Partial<Record<StatusRegistro, number>>;
  },
};
