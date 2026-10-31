/**
 * Memória automática do Argos: depois de cada troca, a IA lê a conversa e guarda sozinha
 * o que a pessoa ensinou e continua valendo (regras, apelidos, método de análise, preferências).
 * Vira um rascunho de nota no Cérebro — o Argos já usa na próxima pergunta, e a tela Revisar
 * continua servindo para aprovar ou descartar.
 */
import { AREAS, AppError, esquemaCriarRegistro, type Area, type MemoriaGuardadaDTO } from "@cerebro/core";
import { registros } from "@cerebro/db";
import { SISTEMA_MEMORIA, embrulharDados, lerJson, mascarar, restaurar, type MemoriaExtraida } from "@cerebro/ia";
import { nomesNoTexto, type TurnoAnterior } from "./agente.js";
import { interpretarRapido } from "./assistente.js";
import { buscar } from "./busca.js";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { indexarRegistro } from "./indexacao.js";
import { atualizarRegistro, criarRegistro } from "./registros.js";

/** Marca no registro: foi guardado pela memória automática (e pode ser atualizado por ela). */
export const VIA_MEMORIA = "memoria";

// Nada disso entra na memória, mesmo que a IA proponha.
const DADO_PESSOAL =
  /(\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b|\bpix\b|chave\s+pix|\bag[eê]ncia\b|conta\s+corrente|\bsenha\b|\btoken\b|\(\d{2}\)\s?9?\d{4}-?\d{4}|\b9\d{4}-?\d{4}\b)/i;

const sem = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

export interface TrocaParaMemoria {
  pergunta: string;
  resposta: string;
  historico?: TurnoAnterior[];
}

export interface MemoriaDoClaude {
  /** Pasta (Projeto) do Claude de onde veio: "Financeiro", "Operações"… */
  projeto?: string | null;
  titulo: string;
  conteudo: string;
  area?: string | null;
  /** O que é: regra, decisão, apelido, processo, preferência ou nota. */
  natureza?: string | null;
  /** Código de uma memória existente que esta corrige. */
  atualiza?: string | null;
}

/**
 * O Claude (conector) guardando o que a pessoa ensinou numa conversa de um Projeto.
 * Mesmas regras da memória do Argos: rascunho para revisar, sem dados pessoais, sem duplicar,
 * uma regra já aprovada nunca é mexida sozinha (vira um rascunho apontando para ela).
 */
export async function guardarDoClaude(ctx: Contexto, ator: Ator, m: MemoriaDoClaude): Promise<MemoriaGuardadaDTO & { aviso?: string }> {
  const titulo = m.titulo.replace(/\s+/g, " ").trim().slice(0, 120);
  const conteudo = m.conteudo.trim().slice(0, 6000);
  const projeto = m.projeto?.replace(/\s+/g, " ").trim().slice(0, 80) || null;
  if (titulo.length < 4 || conteudo.length < 10) throw AppError.requisicaoInvalida("Mande um título e o conteúdo completo do que deve ser guardado.");
  if (DADO_PESSOAL.test(`${titulo}\n${conteudo}`)) throw AppError.requisicaoInvalida("Isso tem dado pessoal (CPF, PIX, conta, senha, telefone): o Cérebro não guarda. Tire esses dados e tente de novo.");
  const area: Area = m.area && (AREAS as readonly string[]).includes(m.area) ? (m.area as Area) : "operacoes";
  const origem = { via: "claude", projeto, natureza: m.natureza?.slice(0, 30) ?? null };

  const alvo = m.atualiza ? await registros.buscarPorCodigo(ctx.pool, m.atualiza.trim().toUpperCase()) : null;
  if (alvo && alvo.status === "rascunho" && ["claude", VIA_MEMORIA].includes((alvo.dados as { via?: string } | null)?.via ?? "")) {
    const r = await atualizarRegistro(ctx, ator, alvo.id, { titulo, conteudo, motivo: `Corrigida pelo Claude${projeto ? ` (projeto ${projeto})` : ""}` });
    await indexarRegistro(ctx, r.id).catch(() => undefined);
    return { registroId: r.id, codigo: r.codigo, titulo: r.titulo, acao: "atualizada" };
  }
  // Mesmo assunto já guardado (título igual): não duplica.
  const parecidos = (await buscar(ctx, { pergunta: titulo, incluirRascunhos: true, incluirRestritos: false }).catch(() => [])).slice(0, 5);
  const igual = parecidos.find((e) => sem(e.titulo) === sem(titulo));
  if (igual && !alvo) return { registroId: igual.registroId, codigo: igual.codigo, titulo: igual.titulo, acao: "atualizada", aviso: `Já existe ${igual.codigo} com esse título; nada novo foi criado. Para corrigir, mande atualiza="${igual.codigo}".` };

  const corpo = `${conteudo}${alvo ? `\n\n_Atualiza ${alvo.codigo} (${alvo.titulo})._` : ""}\n\n_Guardado pelo Claude${projeto ? ` · projeto ${projeto}` : ""}._`;
  const entrada = esquemaCriarRegistro.parse({ tipo: "nota", titulo, conteudo: corpo, area, dados: { ...origem, ...(alvo ? { atualiza: alvo.codigo } : {}) } });
  const r = await criarRegistro(ctx, ator, entrada, { origem: "claude", sempreRascunho: true });
  await indexarRegistro(ctx, r.id).catch(() => undefined);
  await auditar(ctx.pool, ator, "argos.memoria", undefined, { codigos: [r.codigo], via: "claude", projeto });
  return { registroId: r.id, codigo: r.codigo, titulo: r.titulo, acao: "nova" };
}

/** Vale chamar a IA? Cumprimentos, comandos de tela e perguntas curtíssimas não têm o que guardar. */
function vale(pergunta: string) {
  const t = pergunta.trim();
  if (t.length < 18) return false;
  const rapido = interpretarRapido(t);
  if (rapido && (rapido.intencao === "conversa" || rapido.intencao === "navegar")) return false;
  return true;
}

/** Lê a última troca e guarda (ou atualiza) até 3 memórias. Devolve o que foi guardado. */
export async function memorizar(ctx: Contexto, ator: Ator, troca: TrocaParaMemoria): Promise<MemoriaGuardadaDTO[]> {
  if (!ctx.ia || !ator.usuarioId || !vale(troca.pergunta)) return [];

  // O que já existe sobre o assunto: a IA atualiza em vez de duplicar.
  const existentes = (await buscar(ctx, { pergunta: troca.pergunta.slice(0, 900), incluirRascunhos: true, incluirRestritos: false }).catch(() => [])).slice(0, 5);
  const textoExistentes = existentes.length
    ? existentes.map((m) => `[${m.codigo}]${m.status === "rascunho" ? " (rascunho)" : m.status === "vigente" ? " (vigente)" : ""} ${m.titulo}\n${m.trecho}`).join("\n\n")
    : "(nenhuma)";
  const anteriores = (troca.historico ?? []).slice(-2).map((t) => `Pessoa: ${t.pergunta}\nArgos: ${t.resposta.slice(0, 600)}`).join("\n\n");
  const bruto =
    (anteriores ? `Trocas anteriores (só contexto):\n${embrulharDados(anteriores)}\n\n` : "") +
    `Memórias existentes sobre o assunto:\n${embrulharDados(textoExistentes)}\n\n` +
    `Última troca (decida sobre ESTA):\nPessoa: ${embrulharDados(troca.pergunta)}\nArgos: ${embrulharDados(troca.resposta.slice(0, 2000))}`;

  // Nomes de pessoas não vão para a IA externa.
  const { texto, mapa } = mascarar(bruto, { nomes: nomesNoTexto(bruto) });
  let extraidas: MemoriaExtraida[] = [];
  try {
    const resposta = await ctx.ia.gerar({
      sistema: SISTEMA_MEMORIA,
      mensagens: [{ papel: "user", conteudo: texto }],
      json: true,
      temperatura: 0.1,
      maxTokens: 700,
      raciocinio: "desligado",
    });
    const lido = lerJson<{ memorias?: MemoriaExtraida[] }>(restaurar(resposta, mapa));
    extraidas = Array.isArray(lido.memorias) ? lido.memorias.slice(0, 3) : [];
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "memória automática falhou");
    return [];
  }

  const guardadas: MemoriaGuardadaDTO[] = [];
  for (const m of extraidas) {
    const titulo = (m.titulo ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const conteudo = (m.conteudo ?? "").trim().slice(0, 4000);
    if (titulo.length < 4 || conteudo.length < 10) continue;
    if (DADO_PESSOAL.test(`${titulo}\n${conteudo}`) || /\[PESSOA_\d+\]/.test(`${titulo}${conteudo}`)) continue;
    const area: Area = m.area && (AREAS as readonly string[]).includes(m.area) ? (m.area as Area) : "operacoes";

    try {
      // Atualiza uma memória automática existente (rascunho); uma regra já aprovada não é mexida sozinha:
      // vira um rascunho novo apontando para ela, para alguém revisar.
      const alvo = m.atualiza ? await registros.buscarPorCodigo(ctx.pool, m.atualiza.trim().toUpperCase()) : null;
      if (alvo && alvo.status === "rascunho" && (alvo.dados as { via?: string } | null)?.via === VIA_MEMORIA) {
        const r = await atualizarRegistro(ctx, ator, alvo.id, { titulo, conteudo, motivo: "Atualizada pela memória automática do Argos" });
        await indexarRegistro(ctx, r.id).catch(() => undefined);
        guardadas.push({ registroId: r.id, codigo: r.codigo, titulo: r.titulo, acao: "atualizada" });
        continue;
      }
      // Mesmo título que uma memória existente e nada novo: não duplica.
      if (existentes.some((e) => sem(e.titulo) === sem(titulo))) continue;

      const corpo = alvo ? `${conteudo}\n\n_Atualiza ${alvo.codigo} (${alvo.titulo})._` : conteudo;
      const entrada = esquemaCriarRegistro.parse({
        tipo: "nota",
        titulo,
        conteudo: corpo,
        area,
        dados: { via: VIA_MEMORIA, falaOriginal: troca.pergunta.slice(0, 1000), ...(alvo ? { atualiza: alvo.codigo } : {}) },
      });
      const r = await criarRegistro(ctx, ator, entrada, { origem: "manual", sempreRascunho: true });
      // Indexa na hora: a próxima pergunta já encontra (a fila do worker faria isso só depois).
      await indexarRegistro(ctx, r.id).catch(() => undefined);
      guardadas.push({ registroId: r.id, codigo: r.codigo, titulo: r.titulo, acao: "nova" });
    } catch (erro) {
      ctx.log.warn({ erro: (erro as Error).message, titulo }, "não consegui guardar uma memória");
    }
  }
  if (guardadas.length) await auditar(ctx.pool, ator, "argos.memoria", undefined, { codigos: guardadas.map((g) => g.codigo) });
  return guardadas;
}
