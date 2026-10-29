import type { AnexoDTO, ConversaDTO, DadosCentralDTO, MemoriaGuardadaDTO, RespostaAssistenteDTO, ResumoConversaDTO } from "@cerebro/core/publico";
import { useSyncExternalStore } from "react";
import { api } from "../../api/cliente";

/**
 * A conversa com o Argos, compartilhada entre o painel de voz e a tela Perguntar.
 * Fica nesta aba do navegador (para continuar de onde parou) e é gravada no servidor
 * depois de cada troca, para aparecer na lista "Conversas" em qualquer aparelho.
 * É o que dá contexto para perguntas de continuação: "e ontem?", "e o pior motoboy?".
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
const CHAVE_ID = "cerebro:conversa-id";
const MAX_TURNOS = 60;
/** Depois de 30 minutos parado, o histórico deixa de ir para o Argos (a tela continua mostrando). */
const VALIDADE_CONTEXTO_MS = 30 * 60_000;

let turnos: TurnoConversa[] = carregar();
const ouvintes = new Set<() => void>();
const novoId = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)));
let idAtual: string = (() => {
  try {
    return sessionStorage.getItem(CHAVE_ID) || novoId();
  } catch {
    return novoId();
  }
})();

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
    sessionStorage.setItem(CHAVE_ID, idAtual);
  } catch {
    /* sem armazenamento: a conversa fica só na memória */
  }
}

// Grava no servidor pouco depois da última mudança (várias mudanças seguidas = uma gravação).
let gravacao: number | undefined;
function agendarGravacao() {
  window.clearTimeout(gravacao);
  const id = idAtual;
  gravacao = window.setTimeout(() => {
    const prontos = turnos.filter((t) => t.resposta || t.erro);
    if (!prontos.length || id !== idAtual) return;
    void api<ResumoConversaDTO>(`/conversas/${id}`, {
      metodo: "PUT",
      corpo: { turnos: prontos.map((t) => ({ pergunta: t.pergunta, resposta: t.resposta, erro: t.erro, em: t.em, guardadas: t.guardadas })) },
    }).then(
      () => window.dispatchEvent(new Event("conversas:mudou")),
      () => undefined, // sem servidor agora: fica na aba e grava na próxima troca
    );
  }, 700);
}

function mudar(nova: TurnoConversa[], gravar = true) {
  turnos = nova.slice(-MAX_TURNOS);
  salvar();
  if (gravar) agendarGravacao();
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

  /** Nova conversa: a atual continua salva na lista. */
  limpar() {
    window.clearTimeout(gravacao);
    idAtual = novoId();
    mudar([], false);
    anexo.definir(null);
  },

  idAtual: () => idAtual,

  /** Abre uma conversa salva (da lista) e continua nela. */
  async abrir(id: string) {
    const c = await api<ConversaDTO>(`/conversas/${id}`);
    window.clearTimeout(gravacao);
    idAtual = c.id;
    mudar(
      c.turnos.map((t) => ({ id: ++proximo, pergunta: t.pergunta, resposta: t.resposta, erro: t.erro, em: t.em, guardadas: t.guardadas })),
      false,
    );
    anexo.definir(null);
  },

  /** Apaga uma conversa salva; se for a aberta, começa uma nova. */
  async apagar(id: string) {
    await api(`/conversas/${id}`, { metodo: "DELETE" });
    if (id === idAtual) conversa.limpar();
    window.dispatchEvent(new Event("conversas:mudou"));
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
