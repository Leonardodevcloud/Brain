import { createHash } from "node:crypto";
import { criarPool, migrar, type Pool } from "@cerebro/db";
import type { PedidoTexto, ProvedorEmbeddings, ProvedorTexto } from "@cerebro/ia";
import { criarContexto, lerAmbiente, type Contexto, type Log } from "../src/index.js";

export const URL_TESTE = process.env.DATABASE_URL_TESTE ?? "postgres://cerebro:cerebro@localhost:5432/cerebro_teste";

const silencioso: Log = { info() {}, warn() {}, error() {} };

/** Banco limpo: apaga o schema e roda as migrations do zero. */
export async function bancoLimpo(): Promise<Pool> {
  const pool = criarPool({ url: URL_TESTE, max: 4 });
  await pool.query("DROP SCHEMA IF EXISTS cerebro CASCADE");
  await migrar(pool);
  return pool;
}

/** IA de texto falsa: responde conforme o prompt de sistema e guarda o que recebeu. */
export class IaFalsa implements ProvedorTexto {
  readonly nome = "falsa/teste";
  readonly pedidos: PedidoTexto[] = [];
  constructor(private readonly responder: (p: PedidoTexto) => unknown) {}
  async gerar(p: PedidoTexto) {
    this.pedidos.push(p);
    return JSON.stringify(this.responder(p));
  }
}

/** Embeddings falsos e determinísticos: saco de palavras projetado em 64 dimensões. */
export class EmbeddingsFalsos implements ProvedorEmbeddings {
  readonly modelo = "falso";
  readonly dimensoes = 64;
  async gerar(textos: string[]) {
    return textos.map((t) => {
      const v = new Array<number>(64).fill(0);
      for (const palavra of t.toLowerCase().normalize("NFD").replace(/[^a-z\s]/g, "").split(/\s+/)) {
        if (palavra.length < 4) continue;
        const h = createHash("md5").update(palavra).digest();
        v[h[0]! % 64]! += 1;
      }
      const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norma);
    });
  }
}

export function contextoDeTeste(pool: Pool, extras: Partial<Contexto> = {}): Contexto {
  const ambiente = lerAmbiente({
    DATABASE_URL: URL_TESTE,
    JWT_SEGREDO: "s".repeat(40),
    CEREBRO_CHAVE_CIFRA: Buffer.alloc(32, 7).toString("base64"),
    URL_WEB: "https://cerebro.exemplo",
  });
  return { ...criarContexto(pool, ambiente, silencioso), ...extras };
}
