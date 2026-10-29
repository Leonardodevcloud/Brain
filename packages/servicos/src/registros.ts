import {
  AppError,
  calcularRevisarEm,
  formatarCodigo,
  type AtaDados,
  type AtualizarRegistro,
  type CriarRegistro,
  type FiltroRegistros,
  type Origem,
  type RegistroDTO,
  type RegistroResumoDTO,
  type TipoRegistro,
} from "@cerebro/core";
import { emTransacao, registros, type CamposEditaveis, type Cliente, type RegistroLinha } from "@cerebro/db";
import { auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";
import { fila } from "./fila.js";
import { criarTarefaDaAta } from "./tarefas.js";
import { invalidarCacheBusca } from "./busca.js";
import { invalidarCacheMapa } from "./mapa.js";

// ───────────────────────────── Conversão para DTO ─────────────────────────────

export function paraResumo(r: RegistroLinha): RegistroResumoDTO {
  return {
    id: r.id,
    codigo: r.codigo,
    tipo: r.tipo,
    titulo: r.titulo,
    status: r.status,
    area: r.area,
    empresa: r.empresa,
    origem: r.origem,
    versao: r.versao,
    revisarEm: r.revisarEm,
    atualizadoEm: r.atualizadoEm.toISOString(),
    dono: r.donoId ? { id: r.donoId, nome: r.donoNome ?? "" } : null,
  };
}

// ───────────────────────────── Permissões ─────────────────────────────

/** Regra e decisão vigentes mudam só com o administrador (o CEO). */
const TIPOS_SO_ADMIN: TipoRegistro[] = ["politica", "decisao"];

function exigirPessoa(ator: Ator) {
  if (!ator.usuarioId || ator.papel === "sistema") throw AppError.semPermissao();
}

function podeAprovar(ator: Ator, r: Pick<RegistroLinha, "tipo" | "donoId" | "criadoPor">): boolean {
  if (ator.papel === "admin") return true;
  if (ator.papel !== "membro") return false;
  if (TIPOS_SO_ADMIN.includes(r.tipo)) return false;
  return true;
}

function podeEditar(ator: Ator, r: RegistroLinha): boolean {
  if (ator.papel === "admin") return true;
  if (ator.papel !== "membro") return false;
  if (r.status === "rascunho") return true;
  if (TIPOS_SO_ADMIN.includes(r.tipo)) return false;
  return r.donoId === ator.usuarioId || r.criadoPor === ator.usuarioId || r.donoId === null;
}

// ───────────────────────────── Criação ─────────────────────────────

export interface OpcoesCriacao {
  origem: Origem;
  /** Força rascunho mesmo que a entrada peça para publicar (IA, webhooks). */
  sempreRascunho?: boolean;
}

/** Cria o registro dentro de uma transação já aberta. Usado também pela aprovação de atas. */
export async function criarRegistroEm(
  db: Cliente,
  ctx: Contexto,
  ator: Ator,
  entrada: CriarRegistro,
  opcoes: OpcoesCriacao,
): Promise<string> {
  const publicar = entrada.publicar && !opcoes.sempreRascunho;
  if (publicar && !podeAprovar(ator, { tipo: entrada.tipo, donoId: entrada.donoId ?? null, criadoPor: ator.usuarioId })) {
    throw AppError.semPermissao("Só o administrador publica regras e decisões. Salve como rascunho para revisão.");
  }

  const numero = await registros.proximoNumero(db, entrada.tipo);
  const codigo = formatarCodigo(entrada.tipo, numero);
  const id = await registros.inserir(db, codigo, {
    tipo: entrada.tipo,
    titulo: entrada.titulo,
    conteudo: entrada.conteudo,
    area: entrada.area,
    empresa: entrada.empresa,
    status: publicar ? "vigente" : "rascunho",
    confidencialidade: entrada.confidencialidade,
    donoId: entrada.donoId ?? ator.usuarioId,
    revisarEm: publicar ? calcularRevisarEm(entrada.tipo, ctx.agora()) : null,
    origem: opcoes.origem,
    fonteUrl: entrada.fonteUrl ?? null,
    clienteRef: entrada.clienteRef ?? null,
    dados: entrada.dados,
    criadoPor: ator.usuarioId,
  });
  await registros.inserirVersao(db, {
    registroId: id,
    versao: 1,
    titulo: entrada.titulo,
    conteudo: entrada.conteudo,
    metadados: { status: publicar ? "vigente" : "rascunho", origem: opcoes.origem },
    motivo: publicar ? "Criado e publicado" : "Criado como rascunho",
    autorId: ator.usuarioId,
  });
  if (entrada.relacoes.length) await registros.inserirRelacoes(db, id, entrada.relacoes);
  await auditar(db, ator, publicar ? "registro.publicado" : "registro.rascunho", { entidade: "registro", id }, { codigo });
  await fila.indexar(db, id);
  return id;
}

export async function criarRegistro(ctx: Contexto, ator: Ator, entrada: CriarRegistro, opcoes: OpcoesCriacao) {
  const id = await emTransacao(ctx.pool, (db) => criarRegistroEm(db, ctx, ator, entrada, opcoes));
  return obterRegistro(ctx, id);
}

// ───────────────────────────── Leitura ─────────────────────────────

export async function obterRegistro(ctx: Contexto, idOuCodigo: string): Promise<RegistroDTO> {
  const ehUuid = /^[0-9a-f-]{36}$/i.test(idOuCodigo);
  const r = ehUuid
    ? await registros.buscarPorId(ctx.pool, idOuCodigo)
    : await registros.buscarPorCodigo(ctx.pool, idOuCodigo);
  if (!r) throw AppError.naoEncontrado("O registro");
  const [relacoes, versoes] = await Promise.all([
    registros.listarRelacoes(ctx.pool, r.id),
    registros.listarVersoes(ctx.pool, r.id),
  ]);
  return {
    ...paraResumo(r),
    conteudo: r.conteudo,
    confidencialidade: r.confidencialidade,
    clienteRef: r.clienteRef,
    fonteUrl: r.fonteUrl,
    dados: r.dados,
    criadoEm: r.criadoEm.toISOString(),
    relacoes: relacoes.map((rel) => ({
      tipo: rel.tipo,
      sentido: rel.sentido,
      registro: { id: rel.id, codigo: rel.codigo, titulo: rel.titulo, status: rel.status },
    })),
    versoes: versoes.map((v) => ({
      versao: v.versao,
      motivo: v.motivo,
      autor: v.autor,
      criadoEm: v.criadoEm.toISOString(),
    })),
  };
}

export async function listarRegistros(ctx: Contexto, filtro: FiltroRegistros) {
  const { itens, total } = await registros.listar(ctx.pool, filtro);
  return { itens: itens.map(paraResumo), total, pagina: filtro.pagina, porPagina: filtro.porPagina };
}

// ───────────────────────────── Edição ─────────────────────────────

export async function atualizarRegistro(ctx: Contexto, ator: Ator, id: string, entrada: AtualizarRegistro) {
  exigirPessoa(ator);
  await emTransacao(ctx.pool, async (db) => {
    const atual = await registros.buscarPorId(db, id, { travar: true });
    if (!atual) throw AppError.naoEncontrado("O registro");
    if (atual.status === "descartado" || atual.status === "obsoleto") {
      throw AppError.conflito("Este registro não está mais em uso. Crie um novo registro em vez de editá-lo.");
    }
    if (!podeEditar(ator, atual)) throw AppError.semPermissao();

    const { motivo, ...mudancas } = entrada;
    const novaVersao = atual.versao + 1;
    const campos: CamposEditaveis = { ...mudancas, versao: novaVersao };
    await registros.atualizar(db, id, campos);
    await registros.inserirVersao(db, {
      registroId: id,
      versao: novaVersao,
      titulo: mudancas.titulo ?? atual.titulo,
      conteudo: mudancas.conteudo ?? atual.conteudo,
      metadados: { campos: Object.keys(mudancas) },
      motivo,
      autorId: ator.usuarioId,
    });
    await auditar(db, ator, "registro.editado", { entidade: "registro", id }, { codigo: atual.codigo, versao: novaVersao, campos: Object.keys(mudancas) });
    if (mudancas.titulo !== undefined || mudancas.conteudo !== undefined || mudancas.clienteRef !== undefined) {
      await fila.indexar(db, id);
    }
  });
  return obterRegistro(ctx, id);
}

export interface OpcoesAprovacao {
  /** Para atas: índices das decisões que viram registros (padrão: as marcadas na ata). */
  decisoes?: number[];
  /** Para atas: índices das pendências que viram tarefas do Cérebro. */
  pendencias?: number[];
}

/** Rascunho → vigente. Atas também geram decisões e tarefas. */
export async function aprovarRegistro(ctx: Contexto, ator: Ator, id: string, opcoes: OpcoesAprovacao = {}) {
  exigirPessoa(ator);
  await emTransacao(ctx.pool, async (db) => {
    const r = await registros.buscarPorId(db, id, { travar: true });
    if (!r) throw AppError.naoEncontrado("O registro");
    if (r.status !== "rascunho") throw AppError.conflito("Só rascunhos podem ser aprovados.");
    if (!podeAprovar(ator, r)) throw AppError.semPermissao("Só o administrador aprova regras e decisões.");

    await registros.atualizar(db, id, {
      status: "vigente",
      revisarEm: calcularRevisarEm(r.tipo, ctx.agora()),
      donoId: r.donoId ?? ator.usuarioId,
    });

    // O que este registro substitui deixa de valer.
    for (const antigoId of await registros.listarSubstituidos(db, id)) {
      await registros.atualizar(db, antigoId, { status: "obsoleto" });
      await auditar(db, ator, "registro.obsoleto", { entidade: "registro", id: antigoId }, { substituidoPor: id });
    }

    if (r.tipo === "reuniao") await aprovarAta(db, ctx, ator, r, opcoes);
    await auditar(db, ator, "registro.aprovado", { entidade: "registro", id }, { codigo: r.codigo });
  });
  return obterRegistro(ctx, id);
}

async function aprovarAta(db: Cliente, ctx: Contexto, ator: Ator, ata: RegistroLinha, opcoes: OpcoesAprovacao) {
  const dados = ata.dados as unknown as AtaDados;
  const decisoes = (dados.decisoes ?? []).map((d, i) => ({
    ...d,
    aprovar: opcoes.decisoes ? opcoes.decisoes.includes(i) : d.aprovar,
  }));
  const pendencias = (dados.pendencias ?? []).map((p, i) => ({
    ...p,
    criarTarefa: opcoes.pendencias ? opcoes.pendencias.includes(i) : (p.criarTarefa ?? p.criarNoNotion ?? true),
  }));

  // Decisões aprovadas junto com a ata viram registros próprios, ligados a ela.
  // Decisões exigem o administrador; um membro aprova a ata, e as decisões ficam como rascunho.
  for (const decisao of decisoes.filter((d) => d.aprovar)) {
    await criarRegistroEm(
      db,
      ctx,
      ator,
      {
        tipo: "decisao",
        titulo: decisao.texto.length > 120 ? `${decisao.texto.slice(0, 117)}...` : decisao.texto,
        conteudo: `${decisao.texto}\n\nDecidido na reunião ${ata.codigo} · ${ata.titulo}.`,
        area: ata.area,
        empresa: ata.empresa,
        confidencialidade: ata.confidencialidade,
        dados: {},
        publicar: ator.papel === "admin",
        relacoes: [{ destinoId: ata.id, tipo: "referencia" }],
      },
      { origem: "reuniao" },
    );
  }

  await registros.atualizar(db, ata.id, { dados: { ...dados, decisoes, pendencias } });
  // Pendências marcadas viram tarefas do Cérebro, ligadas à ata (aprovar de novo não duplica).
  for (const p of pendencias.filter((x) => x.criarTarefa)) {
    await criarTarefaDaAta(db, ator, ata, p);
  }
}

/**
 * Apaga de vez (só o administrador): o registro, as versões, os trechos da busca e o arquivo enviado.
 * Exige repetir o código, para ninguém apagar o registro errado. Fica na auditoria.
 */
export async function excluirRegistro(ctx: Contexto, ator: Ator, idOuCodigo: string, confirmacao: string) {
  exigirPessoa(ator);
  if (ator.papel !== "admin") throw AppError.semPermissao("Só o administrador exclui registros.");
  const r = /^[0-9a-f-]{36}$/i.test(idOuCodigo) ? await registros.buscarPorId(ctx.pool, idOuCodigo) : await registros.buscarPorCodigo(ctx.pool, idOuCodigo.toUpperCase());
  if (!r) throw AppError.naoEncontrado("O registro");
  if (confirmacao.trim().toUpperCase() !== r.codigo) throw AppError.requisicaoInvalida(`Para excluir, digite o código ${r.codigo}.`);
  await emTransacao(ctx.pool, async (db) => {
    await db.query(`DELETE FROM cerebro.registros WHERE id = $1`, [r.id]);
    await auditar(db, ator, "registro.excluido", { entidade: "registro", id: r.id }, { codigo: r.codigo, titulo: r.titulo, tipo: r.tipo });
  });
  invalidarCacheBusca();
  invalidarCacheMapa();
}

export async function descartarRegistro(ctx: Contexto, ator: Ator, id: string) {
  exigirPessoa(ator);
  await emTransacao(ctx.pool, async (db) => {
    const r = await registros.buscarPorId(db, id, { travar: true });
    if (!r) throw AppError.naoEncontrado("O registro");
    if (r.status !== "rascunho") throw AppError.conflito("Só rascunhos podem ser descartados. Registros publicados viram obsoletos.");
    await registros.atualizar(db, id, { status: "descartado" });
    await auditar(db, ator, "registro.descartado", { entidade: "registro", id }, { codigo: r.codigo });
  });
}

/** Vigente ou em revisão → marca como obsoleto (deixa de aparecer nas respostas). */
export async function tornarObsoleto(ctx: Contexto, ator: Ator, id: string, motivo: string) {
  exigirPessoa(ator);
  await emTransacao(ctx.pool, async (db) => {
    const r = await registros.buscarPorId(db, id, { travar: true });
    if (!r) throw AppError.naoEncontrado("O registro");
    if (r.status !== "vigente" && r.status !== "revisar") throw AppError.conflito("O registro não está publicado.");
    if (!podeEditar(ator, r)) throw AppError.semPermissao();
    await registros.atualizar(db, id, { status: "obsoleto" });
    await auditar(db, ator, "registro.obsoleto", { entidade: "registro", id }, { codigo: r.codigo, motivo });
  });
}

/** O dono confirma que o conteúdo segue válido: volta a vigente e ganha nova data de revisão. */
export async function confirmarRevisao(ctx: Contexto, ator: Ator, id: string) {
  exigirPessoa(ator);
  await emTransacao(ctx.pool, async (db) => {
    const r = await registros.buscarPorId(db, id, { travar: true });
    if (!r) throw AppError.naoEncontrado("O registro");
    if (r.status !== "vigente" && r.status !== "revisar") throw AppError.conflito("Só registros publicados são revisados.");
    if (!podeEditar(ator, r)) throw AppError.semPermissao();
    // Conta o novo prazo a partir do vencimento atual, se ele ainda não chegou
    // (confirmar antes da hora não pode deixar a data igual nem encurtar o prazo).
    const hoje = hojeLocal(ctx.agora());
    const atual = r.revisarEm ? String(r.revisarEm).slice(0, 10) : null;
    const base = atual && atual > hoje ? new Date(`${atual}T12:00:00Z`) : new Date(`${hoje}T12:00:00Z`);
    const revisarEm = calcularRevisarEm(r.tipo, base);
    await registros.atualizar(db, id, { status: "vigente", revisarEm });
    await auditar(db, ator, "registro.revisado", { entidade: "registro", id }, { codigo: r.codigo, antes: atual, depois: revisarEm });
  });
  return obterRegistro(ctx, id);
}

/** Rotina diária: vigentes com revisão vencida passam para "revisar". */
export async function marcarVencidos(ctx: Contexto) {
  const afetados = await registros.marcarVencidos(ctx.pool, hojeLocal(ctx.agora()));
  if (afetados.length) ctx.log.info({ total: afetados.length }, "registros marcados para revisão");
  return afetados;
}
