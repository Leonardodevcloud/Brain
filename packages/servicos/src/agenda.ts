import { AppError, type AgendaDTO, type ItemAgendaDTO } from "@cerebro/core";
import { integracoes, tarefas, usuarios } from "@cerebro/db";
import { auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";
import { acessoAgenda } from "./tarefas.js";

/** O Cérebro opera no horário da Bahia (sem horário de verão). */
const FUSO = "-03:00";
export const MARCA_LEMBRETE = "Lembrete do Second Brain";

const somarDias = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Acesso de leitura: serve qualquer conexão do Google (mesmo a antiga, só leitura). */
async function acessoLeitura(ctx: Contexto) {
  if (!ctx.google || !ctx.cofre) return null;
  const salvo = await integracoes.obter(ctx.pool, "google");
  if (!salvo?.segredo) return null;
  return { google: ctx.google, acesso: await ctx.google.acessoPorRefresh(ctx.cofre.decifrar(salvo.segredo)) };
}

/**
 * Agenda de N dias a partir de `de`: eventos do Google, lembretes e prazos das tarefas abertas.
 * Sem Google conectado, mostra só os prazos.
 */
export async function listarAgenda(ctx: Contexto, _ator: Ator, deEntrada?: string | null, diasEntrada = 7): Promise<AgendaDTO> {
  const hoje = hojeLocal(ctx.agora());
  const de = deEntrada && /^\d{4}-\d{2}-\d{2}$/.test(deEntrada) ? deEntrada : hoje;
  const dias = Math.min(Math.max(Math.round(diasEntrada) || 7, 1), 31);
  const ate = somarDias(de, dias);

  const abertas = await tarefas.listar(ctx.pool, { status: ["a_fazer", "fazendo"], limite: 500 });
  const itens: ItemAgendaDTO[] = [];
  let google: AgendaDTO["google"] = "desligada";
  const eventosVistos = new Set<string>();

  try {
    const g = await acessoLeitura(ctx);
    if (g) {
      const eventos = await g.google.listarEventos(g.acesso, new Date(`${de}T00:00:00${FUSO}`), new Date(`${ate}T00:00:00${FUSO}`));
      google = "ok";
      for (const e of eventos) {
        eventosVistos.add(e.id);
        const diaInteiro = /^\d{4}-\d{2}-\d{2}$/.test(e.inicio);
        const lembrete = (e.descricao ?? "").includes(MARCA_LEMBRETE) || (e.descricao ?? "").includes("do Cérebro:") || e.titulo.startsWith("⏰");
        itens.push({
          id: `g:${e.id}`,
          tipo: lembrete ? "lembrete" : "evento",
          titulo: e.titulo.replace(/^⏰\s*/, ""),
          inicio: e.inicio,
          fim: e.fim,
          diaInteiro,
          chamada: e.link,
          url: e.htmlLink ?? null,
          participantes: e.participantes.slice(0, 12),
          tarefas: abertas.filter((t) => t.eventoId === e.id).map((t) => ({ codigo: t.codigo, titulo: t.titulo })),
          tarefa: null,
        });
      }
    }
  } catch (erro) {
    google = "erro";
    ctx.log.warn({ erro: (erro as Error).message }, "não foi possível ler a agenda");
  }

  for (const t of abertas) {
    if (!t.prazo || t.prazo < de || t.prazo >= ate) continue;
    // O lembrete da tarefa já aparece como evento: não repete.
    if (t.eventoId && eventosVistos.has(t.eventoId) && t.eventoTitulo?.startsWith("✓")) continue;
    itens.push({
      id: `t:${t.id}`,
      tipo: "tarefa",
      titulo: t.titulo,
      inicio: t.prazo,
      fim: null,
      diaInteiro: true,
      chamada: null,
      url: null,
      participantes: [],
      tarefas: [],
      tarefa: { codigo: t.codigo, responsavel: t.responsavelNome ?? t.responsavelTexto, atrasada: t.prazo < hoje },
    });
  }

  const chave = (i: ItemAgendaDTO) => (i.diaInteiro ? `${i.inicio}T00:00:00${FUSO}` : i.inicio);
  itens.sort((a, b) => new Date(chave(a)).getTime() - new Date(chave(b)).getTime());
  return { de, ate, google, itens };
}

/** Lembrete solto na agenda (sem tarefa): "conferir saques às 18h". */
export async function criarLembrete(ctx: Contexto, ator: Ator, entrada: { titulo?: unknown; quando?: unknown; duracaoMin?: unknown }) {
  if (!ator.usuarioId) throw AppError.semPermissao("Só pessoas criam lembretes.");
  const titulo = typeof entrada.titulo === "string" ? entrada.titulo.trim().slice(0, 200) : "";
  const quando = typeof entrada.quando === "string" ? entrada.quando.trim() : "";
  if (titulo.length < 2) throw AppError.requisicaoInvalida("Escreva o que é o lembrete.");
  const diaInteiro = /^\d{4}-\d{2}-\d{2}$/.test(quando);
  const comHora = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(quando);
  if (!diaInteiro && !comHora) throw AppError.requisicaoInvalida("Escolha o dia (e a hora, se quiser).");
  const inicio = comHora && !/[zZ]|[+-]\d{2}:\d{2}$/.test(quando) ? `${quando.slice(0, 16)}:00${FUSO}` : quando;
  const duracao = Math.min(Math.max(Number(entrada.duracaoMin) || 30, 5), 480);

  const quem = await usuarios.buscarPorId(ctx.pool, ator.usuarioId);
  const { google, acesso } = await acessoAgenda(ctx);
  const evento = await google.criarEvento(acesso, {
    titulo: `⏰ ${titulo}`,
    descricao: `${MARCA_LEMBRETE}. Criado por ${quem?.nome ?? "alguém da equipe"}.`,
    inicio: diaInteiro ? quando : new Date(inicio).toISOString(),
    fim: diaInteiro ? undefined : new Date(new Date(inicio).getTime() + duracao * 60_000).toISOString(),
  });
  await auditar(ctx.pool, ator, "agenda.lembrete", undefined, { titulo, quando });
  return { id: evento.id, titulo, inicio: evento.inicio };
}
