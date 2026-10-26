import { timingSafeEqual } from "node:crypto";
import { AppError } from "@cerebro/core";

export function compararTempoConstante(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** `fetch` com timeout e mensagem de erro que não vaza o corpo inteiro da resposta. */
export async function requisitarJson<T>(servico: string, url: string, init: RequestInit = {}): Promise<T> {
  const resposta = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
  const texto = await resposta.text();
  if (!resposta.ok) {
    throw new AppError(502, `erro_${servico.toLowerCase()}`, `${servico} respondeu ${resposta.status}: ${texto.slice(0, 200)}`);
  }
  return (texto ? JSON.parse(texto) : {}) as T;
}
