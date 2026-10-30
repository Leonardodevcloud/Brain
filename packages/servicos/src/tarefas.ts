import {
  AppError,
  esquemaAtualizarTarefa,
  esquemaCriarTarefa,
  type AtaDados,
  type CriarTarefa,
  type DetalheTarefaDTO,
  type ResumoTarefasDTO,
  type TarefaDTO,
  type TipoRegistro,
} from "@cerebro/core";
import {
  auditoria,
  emTransacao,
  integracoes,
  registros,
  tarefas,
  usuarios,
  type Executor,
  type LigacaoTarefa,
  type OrigemTarefa,
  type RegistroLinha,
  type StatusTarefa,
  type TarefaLinha,
  type Recorrencia,
} from "@cerebro/db";
import { ESCOPO_AGENDA } from "@cerebro/integracoes";
import type { z } from "zod";
import { auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";

const DESCRICAO_ACAO: Record<string, string> = {
  "tarefa.criada": "criou",
  "tarefa.editada": "editou",
  "tarefa.movida": "moveu",
  "tarefa.concluida": "concluiu",
  "tarefa.reaberta": "reabriu",
  "tarefa.ligada": "ligou a um registro",
  "tarefa.agenda": "colocou na agenda",
};
const NOME_STATUS: Record<StatusTarefa, string> = { a_fazer: "A fazer", fazendo: "Fazendo", feita: "Feita" };

function exigirPessoa(ator: Ator) {
  if (!ator.usuarioId && ator.canal !== "worker") throw AppError.semPermissao("Faça login para mexer nas tarefas.");
}

function somarDias(iso: string, dias: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** A data da próxima repetição. Mês: mesmo dia no mês seguinte (31 → último dia do mês). */
export function proximaData(prazo: string, r: Recorrencia): string {
  if (r === "diaria") return somarDias(prazo, 1);
  if (r === "semanal") return somarDias(prazo, 7);
  if (r === "quinzenal") return somarDias(prazo, 14);
  const [a, m, d] = prazo.split("-").map(Number) as [number, number, number];
  const ultimo = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(a, m, Math.min(d, ultimo), 12)).toISOString().slice(0, 10);
}

/**
 * Tarefas que se repetem: quando a data da repetição mais recente chega (ou ela é concluída),
 * cria a próxima, com o mesmo título, descrição, responsável e registros ligados.
 * Se ficou para trás (worker parado), pula direto para a próxima data a partir de hoje.
 */
export async function gerarRecorrencias(ctx: Contexto, serieId?: string): Promise<number> {
  const hoje = hojeLocal(ctx.agora());
  let criadas = 0;
  for (const t of await tarefas.ultimasDasSeries(ctx.pool, serieId)) {
    if (!t.recorrencia || !t.prazo) continue;
    if (t.prazo > hoje && t.status !== "feita") continue;
    let proxima = proximaData(t.prazo, t.recorrencia);
    while (proxima < hoje) proxima = proximaData(proxima, t.recorrencia);
    const id = await emTransacao(ctx.pool, async (db) => {
      if (await tarefas.existeNaSerie(db, t.serieId!, proxima)) return null;
      const novo = await tarefas.inserir(db, {
        titulo: t.titulo,
        descricao: t.descricao,
        responsavelId: t.responsavelId,
        responsavelTexto: t.responsavelTexto,
        prazo: proxima,
        origem: t.origem === "ata" ? "manual" : t.origem,
        origemRegistroId: t.origemRegistroId,
        clienteRef: t.clienteRef,
        criadoPor: t.criadoPor,
        recorrencia: t.recorrencia,
        serieId: t.serieId,
      });
      if (!novo) return null;
      for (const l of await tarefas.ligacoes(db, [t.id])) if (l.registroId !== t.origemRegistroId) await tarefas.ligar(db, novo, l.registroId);
      await auditar(db, { usuarioId: null, papel: "sistema", canal: "worker" }, "tarefa.criada", { entidade: "tarefa", id: novo }, { origem: "recorrencia", de: t.codigo });
      return novo;
    }).catch((erro: Error) => {
      ctx.log.warn({ erro: erro.message, tarefa: t.codigo }, "não consegui criar a repetição da tarefa");
      return null;
    });
    if (id) criadas++;
  }
  return criadas;
}

/** Monta o DTO com os registros ligados (origem primeiro). */
function paraDto(t: TarefaLinha, ligacoes: LigacaoTarefa[], hoje: string): TarefaDTO {
  const minhas = ligacoes.filter((l) => l.tarefaId === t.id);
  const vistos = new Set<string>();
  const regs = minhas
    .map((l) => ({ id: l.registroId, codigo: l.codigo, titulo: l.titulo, tipo: l.tipo as TipoRegistro, origem: l.registroId === t.origemRegistroId }))
    .sort((a, b) => Number(b.origem) - Number(a.origem))
    .filter((r) => (vistos.has(r.id) ? false : (vistos.add(r.id), true)));
  return {
    id: t.id,
    codigo: t.codigo,
    titulo: t.titulo,
    descricao: t.descricao,
    status: t.status,
    ordem: t.ordem,
    responsavel: t.responsavelId ? { id: t.responsavelId, nome: t.responsavelNome ?? "?" } : t.responsavelTexto ? { id: null, nome: t.responsavelTexto } : null,
    prazo: t.prazo,
    atrasada: t.status !== "feita" && !!t.prazo && t.prazo < hoje,
    venceEmBreve: t.status !== "feita" && !!t.prazo && t.prazo >= hoje && t.prazo <= somarDias(hoje, 1),
    recorrencia: t.recorrencia,
    origem: t.origem,
    clienteRef: t.clienteRef,
    evento: t.eventoId ? { id: t.eventoId, titulo: t.eventoTitulo ?? "Reunião", inicio: t.eventoInicio?.toISOString() ?? null, url: t.eventoUrl } : null,
    registros: regs,
    criadoEm: t.criadoEm.toISOString(),
    atualizadoEm: t.atualizadoEm.toISOString(),
    concluidaEm: t.concluidaEm?.toISOString() ?? null,
  };
}

async function montar(ctx: Contexto, db: Executor, linhas: TarefaLinha[]) {
  const ligacoes = await tarefas.ligacoes(
    db,
    linhas.map((t) => t.id),
  );
  const hoje = hojeLocal(ctx.agora());
  return linhas.map((t) => paraDto(t, ligacoes, hoje));
}

async function exigirTarefa(db: Executor, idOuCodigo: string) {
  const t = /^TAR-\d+$/i.test(idOuCodigo)
    ? await tarefas.buscarPorCodigo(db, idOuCodigo.toUpperCase())
    : /^[0-9a-f-]{36}$/i.test(idOuCodigo)
      ? await tarefas.buscarPorId(db, idOuCodigo)
      : null;
  if (!t) throw AppError.naoEncontrado("A tarefa");
  return t;
}

/** "Leonardo", "leo", "Supervisão SSA": vira usuário quando o nome bate; senão fica como texto. */
async function resolverResponsavel(db: Executor, texto: string | null | undefined) {
  const t = texto?.trim();
  if (!t) return { responsavelId: null, responsavelTexto: null };
  const todos = await usuarios.listar(db);
  const sem = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const alvo = sem(t);
  const achado =
    todos.find((u) => u.ativo && sem(u.nome) === alvo) ??
    todos.find((u) => u.ativo && sem(u.nome).split(/\s+/)[0] === alvo.split(/\s+/)[0] && alvo.split(/\s+/).length === 1);
  return achado ? { responsavelId: achado.id, responsavelTexto: null } : { responsavelId: null, responsavelTexto: t.slice(0, 120) };
}

// ───────────────────────────── Leitura ─────────────────────────────

export async function listarTarefas(
  ctx: Contexto,
  ator: Ator,
  f: { filtro?: "minhas" | "todas" | "atrasadas" | "feitas"; texto?: string; registroId?: string } = {},
): Promise<TarefaDTO[]> {
  const filtro = f.filtro ?? "todas";
  const linhas = await tarefas.listar(ctx.pool, {
    responsavelId: filtro === "minhas" ? (ator.usuarioId ?? undefined) : undefined,
    atrasadas: filtro === "atrasadas",
    status: filtro === "feitas" ? ["feita"] : undefined,
    feitasDias: filtro === "feitas" ? 60 : 7,
    texto: f.texto || undefined,
    registroId: f.registroId,
  });
  return montar(ctx, ctx.pool, linhas);
}

export async function obterTarefa(ctx: Contexto, idOuCodigo: string): Promise<DetalheTarefaDTO> {
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  const [dto] = await montar(ctx, ctx.pool, [t]);
  const hist = await auditoria.porEntidade(ctx.pool, "tarefa", t.id, 30);
  return {
    ...dto!,
    historico: hist.map((h) => ({
      quando: h.criadoEm.toISOString(),
      quem: h.usuario ?? (h.canal === "worker" ? "O Cérebro" : h.canal === "mcp" ? "Claude" : null),
      acao:
        h.acao === "tarefa.movida" && typeof h.detalhes.para === "string"
          ? `moveu para ${NOME_STATUS[h.detalhes.para as StatusTarefa] ?? h.detalhes.para}`
          : h.acao === "tarefa.criada" && typeof h.detalhes.origem === "string" && h.detalhes.origem !== "manual"
            ? h.detalhes.origem === "recorrencia"
              ? `criou a repetição${typeof h.detalhes.de === "string" ? ` (depois de ${h.detalhes.de})` : ""}`
              : `criou ${h.detalhes.origem === "ata" ? "a partir da ata" : h.detalhes.origem === "argos" ? "pelo Argos" : "pelo Claude"}`
            : (DESCRICAO_ACAO[h.acao] ?? h.acao),
    })),
  };
}

export async function resumoTarefas(ctx: Contexto, ator: Ator): Promise<ResumoTarefasDTO> {
  return tarefas.contarAbertas(ctx.pool, ator.usuarioId);
}

// ───────────────────────────── Escrita ─────────────────────────────

export async function criarTarefa(
  ctx: Contexto,
  ator: Ator,
  entrada: z.input<typeof esquemaCriarTarefa>,
  extras: { origem?: OrigemTarefa; origemRegistroId?: string | null } = {},
): Promise<DetalheTarefaDTO> {
  exigirPessoa(ator);
  const e: CriarTarefa = esquemaCriarTarefa.parse(entrada);
  const id = await emTransacao(ctx.pool, async (db) => {
    const resp = e.responsavelId ? { responsavelId: e.responsavelId, responsavelTexto: null } : await resolverResponsavel(db, e.responsavelTexto);
    const novo = await tarefas.inserir(db, {
      titulo: e.titulo,
      descricao: e.descricao,
      status: e.status,
      ...resp,
      prazo: e.prazo ?? null,
      clienteRef: e.clienteRef ?? null,
      origem: extras.origem ?? (ator.canal === "mcp" ? "claude" : "manual"),
      origemRegistroId: extras.origemRegistroId ?? null,
      criadoPor: ator.usuarioId,
    });
    if (!novo) throw AppError.conflito("Essa tarefa já existe.");
    // Tarefa que se repete: a série começa nela; sem prazo, a primeira vence hoje.
    if (e.recorrencia) await tarefas.atualizar(db, novo, { recorrencia: e.recorrencia, serieId: novo, prazo: e.prazo ?? hojeLocal(ctx.agora()) });
    for (const r of e.registros) {
      if (await registros.buscarPorId(db, r)) await tarefas.ligar(db, novo, r);
    }
    await auditar(db, ator, "tarefa.criada", { entidade: "tarefa", id: novo }, { origem: extras.origem ?? "manual", titulo: e.titulo });
    return novo;
  });
  if (e.recorrencia) await gerarRecorrencias(ctx, id);
  return obterTarefa(ctx, id);
}

/** Pendência de ata aprovada → tarefa. Repetir não duplica. */
export async function criarTarefaDaAta(db: Executor, ator: Ator, ata: RegistroLinha, p: AtaDados["pendencias"][number]) {
  const resp = await resolverResponsavel(db, p.responsavel);
  const id = await tarefas.inserir(db, {
    titulo: p.tarefa.slice(0, 300),
    descricao: `Combinado na reunião ${ata.codigo} · ${ata.titulo}.`,
    ...resp,
    prazo: p.prazo && /^\d{4}-\d{2}-\d{2}$/.test(p.prazo) ? p.prazo : null,
    origem: "ata",
    origemRegistroId: ata.id,
    clienteRef: ata.clienteRef,
    criadoPor: ator.usuarioId,
  });
  if (id) await auditar(db, ator, "tarefa.criada", { entidade: "tarefa", id }, { origem: "ata", ata: ata.codigo });
  return id;
}

export async function atualizarTarefa(ctx: Contexto, ator: Ator, idOuCodigo: string, entrada: unknown): Promise<DetalheTarefaDTO> {
  exigirPessoa(ator);
  const m = esquemaAtualizarTarefa.parse(entrada);
  let serie: string | null = null;
  await emTransacao(ctx.pool, async (db) => {
    const t = await exigirTarefa(db, idOuCodigo);
    const campos: Parameters<typeof tarefas.atualizar>[2] = {
      titulo: m.titulo,
      descricao: m.descricao,
      status: m.status,
      prazo: m.prazo === undefined ? undefined : (m.prazo ?? null),
      clienteRef: m.clienteRef,
    };
    if (m.responsavelId !== undefined) Object.assign(campos, { responsavelId: m.responsavelId, responsavelTexto: null });
    else if (m.responsavelTexto !== undefined) Object.assign(campos, await resolverResponsavel(db, m.responsavelTexto));
    if (m.status && m.status !== t.status) campos.ordem = await tarefas.ordemEntre(db, m.status, null);
    if (m.recorrencia !== undefined) {
      campos.recorrencia = m.recorrencia;
      if (m.recorrencia) {
        campos.serieId = t.serieId ?? t.id;
        if (!t.prazo && !m.prazo) campos.prazo = hojeLocal(ctx.agora());
      }
    }
    await tarefas.atualizar(db, t.id, campos);
    serie = (campos.serieId as string | undefined) ?? t.serieId;
    const acao = m.status && m.status !== t.status ? (m.status === "feita" ? "tarefa.concluida" : t.status === "feita" ? "tarefa.reaberta" : "tarefa.movida") : "tarefa.editada";
    await auditar(db, ator, acao, { entidade: "tarefa", id: t.id }, { para: m.status, campos: Object.keys(m) });
  });
  // Ligou a repetição ou concluiu uma repetição: a próxima já aparece.
  if (serie && (m.recorrencia || m.status === "feita")) await gerarRecorrencias(ctx, serie);
  return obterTarefa(ctx, idOuCodigo);
}

/** Arrastar no quadro: muda a coluna e a posição. */
export async function moverTarefa(ctx: Contexto, ator: Ator, idOuCodigo: string, destino: { status: StatusTarefa; antesDe: string | null }) {
  exigirPessoa(ator);
  let serieMovida: string | null = null;
  await emTransacao(ctx.pool, async (db) => {
    const t = await exigirTarefa(db, idOuCodigo);
    const ordem = await tarefas.ordemEntre(db, destino.status, destino.antesDe && destino.antesDe !== t.id ? destino.antesDe : null);
    await tarefas.atualizar(db, t.id, { status: destino.status, ordem });
    if (destino.status !== t.status) {
      const acao = destino.status === "feita" ? "tarefa.concluida" : t.status === "feita" ? "tarefa.reaberta" : "tarefa.movida";
      await auditar(db, ator, acao, { entidade: "tarefa", id: t.id }, { de: t.status, para: destino.status });
    }
    serieMovida = destino.status === "feita" ? t.serieId : null;
  });
  if (serieMovida) await gerarRecorrencias(ctx, serieMovida);
  return obterTarefa(ctx, idOuCodigo);
}

export async function excluirTarefa(ctx: Contexto, ator: Ator, idOuCodigo: string) {
  exigirPessoa(ator);
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  if (ator.papel !== "admin" && t.criadoPor !== ator.usuarioId) throw AppError.semPermissao("Só quem criou a tarefa ou o administrador pode excluí-la.");
  await tarefas.remover(ctx.pool, t.id);
  await auditar(ctx.pool, ator, "tarefa.excluida", { entidade: "tarefa", id: t.id }, { codigo: t.codigo, titulo: t.titulo });
}

export async function ligarRegistro(ctx: Contexto, ator: Ator, idOuCodigo: string, registroId: string, ligar = true) {
  exigirPessoa(ator);
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  if (!(await registros.buscarPorId(ctx.pool, registroId))) throw AppError.naoEncontrado("O registro");
  if (ligar) await tarefas.ligar(ctx.pool, t.id, registroId);
  else await tarefas.desligar(ctx.pool, t.id, registroId);
  await auditar(ctx.pool, ator, "tarefa.ligada", { entidade: "tarefa", id: t.id }, { registroId, ligar });
  return obterTarefa(ctx, t.id);
}

// ───────────────────────────── Agenda ─────────────────────────────

/** Acesso à agenda com permissão de escrita (o escopo novo). */
export async function acessoAgenda(ctx: Contexto) {
  if (!ctx.google || !ctx.cofre) throw AppError.indisponivel("O Google Agenda não está configurado.");
  const salvo = await integracoes.obter(ctx.pool, "google");
  if (!salvo?.segredo) throw AppError.indisponivel("Conecte o Google Agenda em Integrações.");
  if (salvo.config.escopo !== ESCOPO_AGENDA) {
    throw AppError.indisponivel("Reconecte o Google Agenda em Integrações para o Cérebro poder escrever na agenda.");
  }
  return { google: ctx.google, acesso: await ctx.google.acessoPorRefresh(ctx.cofre.decifrar(salvo.segredo)) };
}

/** Próximas reuniões para escolher onde a tarefa entra na pauta. */
export async function reunioesParaLigar(ctx: Contexto, dias = 21) {
  const { google, acesso } = await acessoAgenda(ctx);
  const agora = ctx.agora();
  const eventos = await google.listarEventos(acesso, new Date(agora.getTime() - 3_600_000), new Date(agora.getTime() + dias * 86_400_000));
  return eventos.map((e) => ({ id: e.id, titulo: e.titulo, inicio: e.inicio, link: e.htmlLink ?? e.link }));
}

const MARCA_PAUTA = "— Pauta do Cérebro —";

/** Liga a tarefa a uma reunião e escreve a pauta na descrição do evento. */
export async function ligarReuniao(ctx: Contexto, ator: Ator, idOuCodigo: string, eventoId: string) {
  exigirPessoa(ator);
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  const { google, acesso } = await acessoAgenda(ctx);
  const evento = await google.obterEvento(acesso, eventoId);
  await tarefas.atualizar(ctx.pool, t.id, {
    eventoId: evento.id,
    eventoTitulo: evento.titulo,
    eventoInicio: new Date(evento.inicio),
    eventoUrl: evento.htmlLink ?? evento.link,
  });
  await escreverPauta(ctx, google, acesso, evento.id, evento.descricao ?? "");
  await auditar(ctx.pool, ator, "tarefa.agenda", { entidade: "tarefa", id: t.id }, { evento: evento.titulo });
  return obterTarefa(ctx, t.id);
}

/** Reescreve o bloco de pauta do evento com as tarefas abertas ligadas a ele (o resto da descrição fica). */
async function escreverPauta(ctx: Contexto, google: NonNullable<Contexto["google"]>, acesso: string, eventoId: string, descricaoAtual: string) {
  const ligadas = (await tarefas.listar(ctx.pool, { status: ["a_fazer", "fazendo"] })).filter((x) => x.eventoId === eventoId);
  const base = descricaoAtual.split(MARCA_PAUTA)[0]!.trimEnd();
  const url = ctx.ambiente.URL_WEB.replace(/\/$/, "");
  const linhas = ligadas.map((x) => `• ${x.codigo} ${x.titulo}${x.responsavelNome || x.responsavelTexto ? ` (${x.responsavelNome ?? x.responsavelTexto})` : ""} — ${url}/tarefas?abrir=${x.codigo}`);
  const nova = linhas.length ? `${base}${base ? "\n\n" : ""}${MARCA_PAUTA}\n${linhas.join("\n")}` : base;
  await google.atualizarDescricao(acesso, eventoId, nova);
}

export async function desligarReuniao(ctx: Contexto, ator: Ator, idOuCodigo: string) {
  exigirPessoa(ator);
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  if (!t.eventoId) return obterTarefa(ctx, t.id);
  const eventoId = t.eventoId;
  await tarefas.atualizar(ctx.pool, t.id, { eventoId: null, eventoTitulo: null, eventoInicio: null, eventoUrl: null });
  try {
    const { google, acesso } = await acessoAgenda(ctx);
    const evento = await google.obterEvento(acesso, eventoId);
    await escreverPauta(ctx, google, acesso, eventoId, evento.descricao ?? "");
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "não consegui tirar a tarefa da pauta");
  }
  return obterTarefa(ctx, t.id);
}

/** Cria um lembrete na agenda: no prazo (dia inteiro) ou num horário escolhido. */
export async function criarLembrete(ctx: Contexto, ator: Ator, idOuCodigo: string, quando?: string | null) {
  exigirPessoa(ator);
  const t = await exigirTarefa(ctx.pool, idOuCodigo);
  const inicio = quando || t.prazo || hojeLocal(ctx.agora());
  const { google, acesso } = await acessoAgenda(ctx);
  const url = `${ctx.ambiente.URL_WEB.replace(/\/$/, "")}/tarefas?abrir=${t.codigo}`;
  const evento = await google.criarEvento(acesso, {
    titulo: `✓ ${t.titulo}`,
    descricao: `${t.descricao ? `${t.descricao}\n\n` : ""}Tarefa ${t.codigo} do Cérebro: ${url}`,
    inicio,
  });
  await tarefas.atualizar(ctx.pool, t.id, {
    eventoId: evento.id,
    eventoTitulo: evento.titulo,
    eventoInicio: new Date(evento.inicio.length === 10 ? `${evento.inicio}T12:00:00Z` : evento.inicio),
    eventoUrl: evento.htmlLink ?? evento.link,
  });
  await auditar(ctx.pool, ator, "tarefa.agenda", { entidade: "tarefa", id: t.id }, { lembrete: inicio });
  return obterTarefa(ctx, t.id);
}
