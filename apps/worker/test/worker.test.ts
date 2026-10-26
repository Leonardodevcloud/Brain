import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarPool, jobs, migrar, type Pool } from "@cerebro/db";
import { criarContexto, lerAmbiente, type Contexto } from "@cerebro/servicos";
import { executarProximo } from "../src/processar.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE ?? "postgres://cerebro:cerebro@localhost:5432/cerebro_teste";
const silencioso = { info() {}, warn() {}, error() {} };
let pool: Pool;
let ctx: Contexto;

beforeAll(async () => {
  pool = criarPool({ url: URL_TESTE, max: 2 });
  await pool.query("DROP SCHEMA IF EXISTS cerebro CASCADE");
  await migrar(pool);
  ctx = criarContexto(pool, lerAmbiente({ DATABASE_URL: URL_TESTE }), silencioso);
});

afterAll(async () => {
  await pool.end();
});

describe("worker", () => {
  it("conclui, reprograma falhas e avisa fila vazia", async () => {
    const vistos: string[] = [];
    const tratadores = {
      ok: async () => void vistos.push("ok"),
      quebra: async () => {
        throw new Error("fora do ar");
      },
    };
    await jobs.enfileirar(pool, "ok", {});
    await jobs.enfileirar(pool, "quebra", {}, { maxTentativas: 3 });

    expect(await executarProximo(ctx, tratadores)).toBe(true);
    expect(await executarProximo(ctx, tratadores)).toBe(true);
    expect(await executarProximo(ctx, tratadores)).toBe(false);
    expect(vistos).toEqual(["ok"]);

    const { rows } = await pool.query(`SELECT tipo, status, erro FROM cerebro.jobs ORDER BY id`);
    expect(rows).toEqual([
      { tipo: "ok", status: "concluido", erro: null },
      { tipo: "quebra", status: "pendente", erro: "fora do ar" },
    ]);
  });

  it("falha de vez um tipo desconhecido sem travar a fila", async () => {
    await jobs.enfileirar(pool, "inexistente", {}, { maxTentativas: 1 });
    expect(await executarProximo(ctx, {})).toBe(true);
    const { rows } = await pool.query(`SELECT status FROM cerebro.jobs WHERE tipo = 'inexistente'`);
    expect(rows[0].status).toBe("falhou");
  });
});
