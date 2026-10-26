import type { UsuarioDTO } from "@cerebro/core/publico";

/** Erro vindo da API, já com a mensagem pronta para mostrar. */
export class ErroApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
    readonly detalhes?: { campo: string; mensagem: string }[],
  ) {
    super(mensagem);
  }
}

// O token de acesso vive só na memória; o refresh fica no cookie httpOnly.
let tokenAcesso: string | null = null;
let renovando: Promise<RespostaSessao | null> | null = null;
const ouvintesExpirou = new Set<() => void>();

export interface RespostaSessao {
  usuario: UsuarioDTO;
  tokenAcesso: string;
}

export function aoExpirarSessao(fn: () => void) {
  ouvintesExpirou.add(fn);
  return () => {
    ouvintesExpirou.delete(fn);
  };
}

export function definirToken(t: string | null) {
  tokenAcesso = t;
}

async function lerErro(res: Response): Promise<ErroApi> {
  try {
    const { erro } = (await res.json()) as { erro: { codigo: string; mensagem: string; detalhes?: unknown } };
    return new ErroApi(res.status, erro.codigo, erro.mensagem, Array.isArray(erro.detalhes) ? erro.detalhes : undefined);
  } catch {
    return new ErroApi(res.status, "rede", res.status >= 500 ? "O servidor não respondeu. Tente de novo em instantes." : "Algo deu errado.");
  }
}

/** Troca o cookie de sessão por um token novo. Chamadas simultâneas compartilham a mesma renovação. */
export function renovarSessao(): Promise<RespostaSessao | null> {
  renovando ??= fetch("/api/auth/renovar", { method: "POST", credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) return null;
      const dados = (await res.json()) as RespostaSessao;
      tokenAcesso = dados.tokenAcesso;
      return dados;
    })
    .catch(() => null)
    .finally(() => {
      renovando = null;
    });
  return renovando;
}

interface Opcoes {
  metodo?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  corpo?: unknown;
  /** Envia um arquivo cru (ex.: .zip) em vez de JSON. */
  arquivo?: Blob;
  sinal?: AbortSignal;
}

export async function api<T>(caminho: string, { metodo = "GET", corpo, arquivo, sinal }: Opcoes = {}, tentativa = 0): Promise<T> {
  const headers: Record<string, string> = {};
  if (tokenAcesso) headers.authorization = `Bearer ${tokenAcesso}`;
  if (corpo !== undefined) headers["content-type"] = "application/json";
  if (arquivo) headers["content-type"] = arquivo.type || "application/zip";

  let res: Response;
  try {
    res = await fetch(`/api${caminho}`, {
      method: metodo,
      headers,
      body: arquivo ?? (corpo !== undefined ? JSON.stringify(corpo) : undefined),
      credentials: "same-origin",
      signal: sinal,
    });
  } catch (erro) {
    if ((erro as Error).name === "AbortError") throw erro;
    throw new ErroApi(0, "rede", "Sem conexão com o servidor. Confira sua internet e tente de novo.");
  }

  if (res.status === 401 && tentativa === 0 && !caminho.startsWith("/auth/")) {
    if (await renovarSessao()) return api<T>(caminho, { metodo, corpo, arquivo, sinal }, 1);
    tokenAcesso = null;
    ouvintesExpirou.forEach((fn) => fn());
  }
  if (!res.ok) throw await lerErro(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
