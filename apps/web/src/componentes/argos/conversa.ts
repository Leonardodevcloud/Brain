import type { DadosCentralDTO, RespostaAssistenteDTO } from "@cerebro/core/publico";
import { useSyncExternalStore } from "react";

/**
 * A conversa com o Argos, compartilhada entre o painel de voz e a tela Perguntar.
 * Fica guardada nesta aba do navegador (some ao fechar a aba) e é o que dá contexto
 * para perguntas de continuação: "e ontem?", "e o pior motoboy?", "manda isso pro Marcos".
 */
export interface TurnoConversa {
  id: number;
  pergunta: string;
  resposta: RespostaAssistenteDTO | null;
  erro: string | null;
  em: number;
}

const CHAVE = "cerebro:conversa";
const MAX_TURNOS = 30;
/** Depois de 30 minutos parado, o histórico deixa de ir para o Argos (a tela continua mostrando). */
const VALIDADE_CONTEXTO_MS = 30 * 60_000;

let turnos: TurnoConversa[] = carregar();
const ouvintes = new Set<() => void>();

function carregar(): TurnoConversa[] {
  try {
    const bruto = sessionStorage.getItem(CHAVE) ?? sessionStorage.getItem("cerebro:perguntar");
    const lista = bruto ? (JSON.parse(bruto) as TurnoConversa[]) : [];
    return Array.isArray(lista) ? lista.filter((t) => t && (t.resposta || t.erro)).slice(-MAX_TURNOS) : [];
  } catch {
    return [];
  }
}

function salvar() {
  try {
    sessionStorage.setItem(CHAVE, JSON.stringify(turnos.filter((t) => t.resposta || t.erro).slice(-MAX_TURNOS)));
  } catch {
    /* sem armazenamento: a conversa fica só na memória */
  }
}

function mudar(nova: TurnoConversa[]) {
  turnos = nova.slice(-MAX_TURNOS);
  salvar();
  for (const fn of ouvintes) fn();
}

let proximo = Date.now();

/** Resumo de uma tabela para o Argos lembrar do que mostrou (sem mandar tudo de novo). */
function resumoDados(d: DadosCentralDTO): string {
  const destaques = d.destaques.map((x) => `${x.rotulo}: ${x.valor}`).join("; ");
  const colunas = d.colunas.slice(0, 8);
  const linhas = d.linhas
    .slice(0, 12)
    .map((l) => colunas.map((c) => String(l[c] ?? "")).join(" | "))
    .join("\n");
  return `\n[Tabela mostrada: ${d.titulo}${destaques ? ` — ${destaques}` : ""}]\n${colunas.join(" | ")}\n${linhas}${d.linhas.length > 12 ? `\n(+${d.linhas.length - 12} linhas)` : ""}`;
}

export const conversa = {
  lista: () => turnos,

  adicionar(pergunta: string): number {
    const id = ++proximo;
    mudar([...turnos, { id, pergunta, resposta: null, erro: null, em: Date.now() }]);
    return id;
  },

  responder(id: number, r: RespostaAssistenteDTO) {
    mudar(turnos.map((t) => (t.id === id ? { ...t, resposta: r, erro: null } : t)));
  },

  falhar(id: number, erro: string) {
    mudar(turnos.map((t) => (t.id === id ? { ...t, erro } : t)));
  },

  remover(id: number) {
    mudar(turnos.filter((t) => t.id !== id));
  },

  limpar() {
    mudar([]);
  },

  /** O que vai para o Argos como contexto: as últimas trocas recentes, com o resumo das tabelas. */
  historicoParaApi(): { pergunta: string; resposta: string }[] {
    const agora = Date.now();
    return turnos
      .filter((t) => t.resposta && agora - t.em < VALIDADE_CONTEXTO_MS)
      .slice(-8)
      .map((t) => {
        const r = t.resposta!;
        const texto = `${r.detalhe ? `${r.fala}\n${r.detalhe}` : r.fala}${r.dados ? resumoDados(r.dados) : ""}`;
        return { pergunta: t.pergunta.slice(0, 1000), resposta: texto.slice(0, 4000) };
      });
  },
};

const assinar = (fn: () => void) => {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
};

export function useConversa() {
  return useSyncExternalStore(assinar, conversa.lista, conversa.lista);
}
