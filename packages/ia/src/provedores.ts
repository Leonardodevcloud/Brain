import { AppError } from "@cerebro/core";
import { normalizar } from "./texto.js";

// ───────────────────────────── Geração de texto ─────────────────────────────

export interface Mensagem {
  papel: "user" | "assistant";
  conteudo: string;
}

export interface PedidoTexto {
  sistema: string;
  mensagens: Mensagem[];
  /** Pede ao modelo um objeto JSON válido como resposta. */
  json?: boolean;
  temperatura?: number;
  maxTokens?: number;
}

export interface ProvedorTexto {
  readonly nome: string;
  gerar(pedido: PedidoTexto): Promise<string>;
}

/**
 * Cliente para qualquer API compatível com OpenAI (DeepSeek, ou o mesmo modelo
 * hospedado fora da China). Trocar de provedor = trocar `baseUrl` e `modelo` nas variáveis.
 */
export class ProvedorCompativelOpenAI implements ProvedorTexto {
  readonly nome: string;

  constructor(
    private readonly cfg: { baseUrl: string; chave: string; modelo: string; timeoutMs?: number },
  ) {
    this.nome = `${new URL(cfg.baseUrl).hostname}/${cfg.modelo}`;
  }

  async gerar(p: PedidoTexto): Promise<string> {
    const resposta = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.chave}` },
      body: JSON.stringify({
        model: this.cfg.modelo,
        messages: [
          { role: "system", content: p.sistema },
          ...p.mensagens.map((m) => ({ role: m.papel, content: m.conteudo })),
        ],
        temperature: p.temperatura ?? 0.2,
        max_tokens: p.maxTokens ?? 2000,
        ...(p.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 90_000),
    });
    if (!resposta.ok) {
      const corpo = (await resposta.text()).slice(0, 300);
      throw AppError.indisponivel(`A IA de análise respondeu ${resposta.status}: ${corpo}`);
    }
    const dados = (await resposta.json()) as { choices?: { message?: { content?: string } }[] };
    const texto = dados.choices?.[0]?.message?.content;
    if (!texto) throw AppError.indisponivel("A IA de análise devolveu uma resposta vazia.");
    return texto;
  }
}

/** Lê a resposta JSON do modelo, tolerando cercas de código em volta. */
export function lerJson<T>(texto: string): T {
  const semCerca = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(semCerca) as T;
}

// ───────────────────────────── Embeddings ─────────────────────────────

export type TipoEmbedding = "documento" | "consulta";

export interface ProvedorEmbeddings {
  readonly modelo: string;
  readonly dimensoes: number;
  gerar(textos: string[], tipo: TipoEmbedding): Promise<number[][]>;
}

/** Gemini Embedding via REST, reduzido para `dimensoes` e normalizado. */
export class EmbeddingsGemini implements ProvedorEmbeddings {
  readonly modelo: string;
  readonly dimensoes: number;

  constructor(private readonly cfg: { chave: string; modelo?: string; dimensoes?: number }) {
    this.modelo = cfg.modelo ?? "gemini-embedding-001";
    this.dimensoes = cfg.dimensoes ?? 768;
  }

  async gerar(textos: string[], tipo: TipoEmbedding): Promise<number[][]> {
    const resultado: number[][] = [];
    // A API aceita lotes; 50 por chamada deixa folga nos limites.
    for (let i = 0; i < textos.length; i += 50) {
      const lote = textos.slice(i, i + 50);
      const resposta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.modelo}:batchEmbedContents`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.cfg.chave },
          body: JSON.stringify({
            requests: lote.map((texto) => ({
              model: `models/${this.modelo}`,
              content: { parts: [{ text: texto }] },
              taskType: tipo === "documento" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
              outputDimensionality: this.dimensoes,
            })),
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!resposta.ok) {
        throw AppError.indisponivel(`O serviço de embeddings respondeu ${resposta.status}.`);
      }
      const dados = (await resposta.json()) as { embeddings?: { values: number[] }[] };
      if (!dados.embeddings || dados.embeddings.length !== lote.length) {
        throw AppError.indisponivel("O serviço de embeddings devolveu uma quantidade inesperada de vetores.");
      }
      // Vetores truncados precisam ser normalizados de novo.
      resultado.push(...dados.embeddings.map((e) => normalizar(e.values)));
    }
    return resultado;
  }
}
