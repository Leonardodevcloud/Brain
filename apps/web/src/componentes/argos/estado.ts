import { useSyncExternalStore } from "react";

/**
 * Estado público do Argos (o motor de voz mora no componente Argos, montado uma vez no layout).
 * A tela Perguntar lê isto para desenhar a esfera e o status, e usa `controleArgos` para falar,
 * enviar e silenciar — o mesmo motor do painel, sem duplicar a lógica de voz.
 */
export type FaseArgos = "fechado" | "ouvindo" | "transcrevendo" | "pensando" | "falando" | "pronto" | "erro";

export interface EstadoArgos {
  fase: FaseArgos;
  segundos: number;
  erro: string | null;
  mudo: boolean;
  /** Modo conversa: depois de responder, volta a ouvir sozinho. */
  conversa: boolean;
}

let estado: EstadoArgos = { fase: "fechado", segundos: 0, erro: null, mudo: false, conversa: false };
const ouvintes = new Set<() => void>();

export function publicarEstadoArgos(novo: EstadoArgos) {
  if (
    novo.fase === estado.fase &&
    novo.segundos === estado.segundos &&
    novo.erro === estado.erro &&
    novo.mudo === estado.mudo &&
    novo.conversa === estado.conversa
  )
    return;
  estado = novo;
  for (const fn of ouvintes) fn();
}

const assinar = (fn: () => void) => {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
};
const ler = () => estado;

export function useEstadoArgos() {
  return useSyncExternalStore(assinar, ler, ler);
}

/** Ações do motor; o componente Argos preenche ao montar. */
export const controleArgos = {
  /** Volume 0–1 do microfone ou da fala (para a esfera). */
  nivel: (): number => 0,
  /** Começa a ouvir; se já está ouvindo, envia o que foi falado. */
  falarOuEnviar: (): void => undefined,
  /** Cancela o que estiver acontecendo (gravação, resposta, voz). */
  cancelar: (): void => undefined,
  alternarMudo: (): void => undefined,
};

/** Envia uma pergunta digitada pelo mesmo caminho da voz (resposta falada, memória, histórico). */
export function perguntarAoArgos(texto: string) {
  window.dispatchEvent(new CustomEvent("argos:perguntar", { detail: texto }));
}
