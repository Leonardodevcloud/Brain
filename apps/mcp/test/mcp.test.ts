import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { esquemaCriarRegistro } from "@cerebro/core";
import { criarPool, jobs, migrar, type Pool } from "@cerebro/db";
import { acesso, conhecimento, criarContexto, indexarRegistro, invalidarCacheBusca, lerAmbiente } from "@cerebro/servicos";
import { criarAppMcp } from "../src/app.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE ?? "postgres://cerebro:cerebro@localhost:5432/cerebro_teste";
const silencioso = { info() {}, warn() {}, error() {} };

let pool: Pool;
let servidor: Server;
let base: string;
let token: string;

type Resultado = { content: { type: string; text: string }[]; isError?: boolean };

async function conectar(url: string) {
  const cliente = new Client({ name: "teste", version: "1.0.0" });
  await cliente.connect(new StreamableHTTPClientTransport(new URL(url)));
  return cliente;
}

beforeAll(async () => {
  pool = criarPool({ url: URL_TESTE, max: 3 });
  await pool.query("DROP SCHEMA IF EXISTS cerebro CASCADE");
  await migrar(pool);
  const ctx = criarContexto(pool, lerAmbiente({ DATABASE_URL: URL_TESTE, URL_WEB: "https://cerebro.exemplo", CONFIAR_PROXY: "0" }), silencioso);
  const admin = await acesso.criarUsuario(ctx, null, { nome: "Admin", email: "a@tutts.com.br", senha: "senhaForte123", papel: "admin" });
  const ator = { usuarioId: admin.id, papel: "admin" as const, canal: "web" as const };
  await conhecimento.criarRegistro(
    ctx,
    ator,
    esquemaCriarRegistro.parse({
      tipo: "pop",
      titulo: "Troca de motoboy em rota",
      conteudo: "Quando faltar motoboy, realoque o profissional da janela seguinte e avise a loja.",
      publicar: true,
    }),
    { origem: "manual" },
  );
  await conhecimento.criarRegistro(
    ctx,
    ator,
    esquemaCriarRegistro.parse({ tipo: "cliente", titulo: "Contrato confidencial", conteudo: "Valores.", confidencialidade: "restrito", publicar: true }),
    { origem: "manual" },
  );
  for (let job = await jobs.reservar(pool); job; job = await jobs.reservar(pool)) {
    await indexarRegistro(ctx, job.payload.registroId as string);
    await jobs.concluir(pool, job.id);
  }
  invalidarCacheBusca();
  token = (await acesso.criarTokenConector(ctx, ator, "Claude")).token;
  servidor = criarAppMcp(ctx).listen(0);
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

afterAll(async () => {
  servidor.close();
  await pool.end();
});

describe("MCP", () => {
  it("recusa sem token válido", async () => {
    await expect(conectar(`${base}/mcp/cbr_invalido`)).rejects.toThrow();
  });

  it("lista as ferramentas", async () => {
    const cliente = await conectar(`${base}/mcp/${token}`);
    const { tools } = await cliente.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "atualizar_tarefa",
      "buscar_conhecimento",
      "catalogo_central",
      "colunas_central",
      "consultar_central",
      "criar_tarefa",
      "indicador_central",
      "ler_registro",
      "listar_pendencias",
      "listar_tarefas",
      "salvar_rascunho",
    ]);
    await cliente.close();
  });

  it("busca, lê e protege o conteúdo restrito", async () => {
    const cliente = await conectar(`${base}/mcp/${token}`);
    const busca = (await cliente.callTool({ name: "buscar_conhecimento", arguments: { pergunta: "falta de motoboy" } })) as Resultado;
    expect(busca.content[0]!.text).toContain("POP-001");

    const leitura = (await cliente.callTool({ name: "ler_registro", arguments: { codigo: "pop-001" } })) as Resultado;
    expect(leitura.content[0]!.text).toContain("# POP-001 — Troca de motoboy em rota");

    const restrito = (await cliente.callTool({ name: "ler_registro", arguments: { codigo: "CLI-001" } })) as Resultado;
    expect(restrito.isError).toBe(true);
    expect(restrito.content[0]!.text).toContain("restrito");
    await cliente.close();
  });

  it("salva sempre como rascunho, ligado ao que substitui", async () => {
    const cliente = await conectar(`${base}/mcp/${token}`);
    const r = (await cliente.callTool({
      name: "salvar_rascunho",
      arguments: { tipo: "pop", titulo: "Troca de motoboy v2", conteudo: "Novo passo a passo da troca.", substitui: "POP-001" },
    })) as Resultado;
    expect(r.content[0]!.text).toMatch(/Rascunho POP-002 salvo/);
    const { rows } = await pool.query(`SELECT status, origem FROM cerebro.registros WHERE codigo = 'POP-002'`);
    expect(rows[0]).toEqual({ status: "rascunho", origem: "claude" });

    const pend = (await cliente.callTool({ name: "listar_pendencias", arguments: {} })) as Resultado;
    expect(pend.content[0]!.text).toContain("POP-002");
    await cliente.close();
  });

  it("cria e lista tarefas; sem a Central ligada, explica o que falta", async () => {
    const cliente = await conectar(`${base}/mcp/${token}`);
    const t = (await cliente.callTool({
      name: "criar_tarefa",
      arguments: { titulo: "Ligar para a Rede Beta", prazo: "2026-11-02", registro: "POP-001" },
    })) as Resultado;
    expect(t.content[0]!.text).toMatch(/Tarefa TAR-\d+ criada/);
    const lista = (await cliente.callTool({ name: "listar_tarefas", arguments: { filtro: "todas" } })) as Resultado;
    expect(lista.content[0]!.text).toMatch(/Ligar para a Rede Beta .*de POP-001/);
    const central = (await cliente.callTool({ name: "consultar_central", arguments: { sql: "SELECT 1" } })) as Resultado & { isError?: boolean };
    expect(central.isError).toBe(true);
    expect(central.content[0]!.text).toMatch(/ARGOS_DB_SENHA/);
    await cliente.close();
  });

  it("aceita também o token no cabeçalho Authorization", async () => {
    const cliente = new Client({ name: "teste", version: "1.0.0" });
    await cliente.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
    );
    expect((await cliente.listTools()).tools).toHaveLength(11);
    await cliente.close();
  });
});
