import type { AnexoDTO, DadosCentralDTO, MemoriaGuardadaDTO, RespostaAssistenteDTO } from "@cerebro/core/publico";
import { useSyncExternalStore } from "react";
import { api } from "../../api/cliente";

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
  /** O que o Argos guardou sozinho depois desta troca (memória automática). */
  guardadas?: MemoriaGuardadaDTO[];
  /** Planilha que estava anexada quando a pergunta foi feita. */
  anexo?: { id: string; nome: string } | null;
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
    const a = anexoAtual;
    mudar([...turnos, { id, pergunta, resposta: null, erro: null, em: Date.now(), anexo: a ? { id: a.id, nome: a.nome } : null }]);
    return id;
  },

  memorizou(id: number, guardadas: MemoriaGuardadaDTO[]) {
    if (guardadas.length) mudar(turnos.map((t) => (t.id === id ? { ...t, guardadas: [...(t.guardadas ?? []), ...guardadas] } : t)));
  },

  esqueceu(id: number, registroId: string) {
    mudar(turnos.map((t) => (t.id === id ? { ...t, guardadas: (t.guardadas ?? []).filter((g) => g.registroId !== registroId) } : t)));
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
    anexo.definir(null);
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

/**
 * Memória automática: depois de cada resposta, pede ao Argos para guardar o que valer.
 * Roda em segundo plano (a resposta e a voz não esperam por isso).
 */
export function memorizarDepois(id: number) {
  const t = turnos.find((x) => x.id === id);
  if (!t?.resposta) return;
  const r = t.resposta;
  const historico = conversa.historicoParaApi().filter((h) => h.pergunta !== t.pergunta).slice(-2);
  void api<{ guardadas: MemoriaGuardadaDTO[] }>("/argos/memorizar", {
    metodo: "POST",
    corpo: { pergunta: t.pergunta.slice(0, 1000), resposta: (r.detalhe ? `${r.fala}\n${r.detalhe}` : r.fala).slice(0, 6000), historico },
  }).then(
    (x) => conversa.memorizou(id, x.guardadas ?? []),
    () => undefined, // memória é melhor esforço: falha aqui não atrapalha a conversa
  );
}

// ── Planilha anexada: vale para as próximas perguntas até ser tirada ──

const CHAVE_ANEXO = "cerebro:anexo";
let anexoAtual: AnexoDTO | null = (() => {
  try {
    const bruto = sessionStorage.getItem(CHAVE_ANEXO);
    return bruto ? (JSON.parse(bruto) as AnexoDTO) : null;
  } catch {
    return null;
  }
})();
const ouvintesAnexo = new Set<() => void>();

export const anexo = {
  atual: () => anexoAtual,
  definir(a: AnexoDTO | null) {
    anexoAtual = a;
    try {
      if (a) sessionStorage.setItem(CHAVE_ANEXO, JSON.stringify(a));
      else sessionStorage.removeItem(CHAVE_ANEXO);
    } catch {
      /* sem armazenamento: vale só nesta página */
    }
    for (const fn of ouvintesAnexo) fn();
  },
};

const assinarAnexo = (fn: () => void) => {
  ouvintesAnexo.add(fn);
  return () => ouvintesAnexo.delete(fn);
};

export function useAnexo() {
  return useSyncExternalStore(assinarAnexo, anexo.atual, anexo.atual);
}

/** Envia a planilha para o servidor; ela passa a acompanhar as perguntas. */
export async function anexarPlanilha(arquivo: File): Promise<AnexoDTO> {
  const a = await api<AnexoDTO>(`/argos/anexos?nome=${encodeURIComponent(arquivo.name)}`, {
    metodo: "POST",
    arquivo: arquivo.type ? arquivo : new Blob([arquivo], { type: "application/octet-stream" }),
  });
  anexo.definir(a);
  return a;
}
