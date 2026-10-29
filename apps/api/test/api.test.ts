import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmissorTokens } from "@cerebro/auth";
import { criarPool, migrar, type Pool } from "@cerebro/db";
import { acesso, criarContexto, lerAmbiente } from "@cerebro/servicos";
import { criarApp } from "../src/app.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE ?? "postgres://cerebro:cerebro@localhost:5432/cerebro_teste";
const SEGREDO_FATHOM = `whsec_${Buffer.from("segredo-de-teste").toString("base64")}`;
const silencioso = { info() {}, warn() {}, error() {} };

let pool: Pool;
let servidor: Server;
let base: string;

beforeAll(async () => {
  pool = criarPool({ url: URL_TESTE, max: 3 });
  await pool.query("DROP SCHEMA IF EXISTS cerebro CASCADE");
  await migrar(pool);
  const ambiente = lerAmbiente({
    DATABASE_URL: URL_TESTE,
    JWT_SEGREDO: "j".repeat(40),
    URL_WEB: "http://web.teste",
    FATHOM_WEBHOOK_SEGREDO: SEGREDO_FATHOM,
    CONFIAR_PROXY: "0",
  });
  const ctx = criarContexto(pool, ambiente, silencioso);
  await acesso.criarUsuario(ctx, null, { nome: "Admin", email: "admin@tutts.com.br", senha: "senhaForte123", papel: "admin" });
  servidor = criarApp({ ctx, emissor: new EmissorTokens(ambiente.JWT_SEGREDO!) }).listen(0);
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  servidor.close();
  await pool.end();
});

async function chamar(caminho: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(base + caminho, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const texto = await res.text();
  return { status: res.status, corpo: texto ? JSON.parse(texto) : null, headers: res.headers };
}

describe("API", () => {
  let token: string;
  let cookie: string;

  it("responde a saúde sem login e recusa rotas protegidas", async () => {
    expect((await chamar("/saude")).status).toBe(200);
    expect((await chamar("/registros")).status).toBe(401);
  });

  it("entra, grava o cookie de sessão restrito e renova", async () => {
    const r = await chamar("/auth/entrar", { method: "POST", json: { email: "admin@tutts.com.br", senha: "senhaForte123" } });
    expect(r.status).toBe(200);
    token = r.corpo.tokenAcesso;
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/);
    cookie = setCookie.split(";")[0]!;

    const renovado = await chamar("/auth/renovar", { method: "POST", headers: { cookie } });
    expect(renovado.status).toBe(200);
    expect(renovado.corpo.usuario.email).toBe("admin@tutts.com.br");
  });

  it("recusa renovar a partir de outra origem", async () => {
    const r = await chamar("/auth/renovar", { method: "POST", headers: { cookie, origin: "https://malicioso.exemplo" } });
    expect(r.status).toBe(403);
  });

  it("valida a entrada e devolve os campos com problema", async () => {
    const r = await chamar("/registros", { method: "POST", token, json: { tipo: "pop", titulo: "x" } });
    expect(r.status).toBe(400);
    expect(r.corpo.erro.detalhes.map((d: { campo: string }) => d.campo)).toEqual(expect.arrayContaining(["titulo", "conteudo"]));
  });

  it("cria, busca por código, edita e lista registros", async () => {
    const criado = await chamar("/registros", {
      method: "POST",
      token,
      json: { tipo: "pop", titulo: "Troca de motoboy", conteudo: "Realoque e avise a loja.", publicar: true },
    });
    expect(criado.status).toBe(201);
    expect(criado.corpo.codigo).toBe("POP-001");

    const porCodigo = await chamar("/registros/POP-001", { token });
    expect(porCodigo.corpo.id).toBe(criado.corpo.id);

    const editado = await chamar(`/registros/${criado.corpo.id}`, {
      method: "PATCH",
      token,
      json: { conteudo: "Realoque, avise a loja e registre.", motivo: "Registrar a troca" },
    });
    expect(editado.corpo.versao).toBe(2);

    const lista = await chamar("/registros?tipo=pop", { token });
    expect(lista.corpo.total).toBe(1);
  });

  it("rejeita JSON malformado com mensagem clara", async () => {
    const r = await chamar("/perguntar", { method: "POST", token, headers: { "content-type": "application/json" }, body: "{" });
    expect(r.status).toBe(400);
    expect(r.corpo.erro.codigo).toBe("json_invalido");
  });

  it("aceita o webhook da Fathom só com assinatura válida e não duplica", async () => {
    const corpo = JSON.stringify({
      recording_id: 123,
      title: "Alinhamento",
      url: "https://fathom.video/calls/123",
      transcript: [{ speaker: { display_name: "Ana" }, text: "Vamos avisar as lojas antes das 8h30.", timestamp: "00:00:05" }],
    });
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const chave = Buffer.from(SEGREDO_FATHOM.slice(6), "base64");
    const assinatura = createHmac("sha256", chave).update(`${id}.${ts}.${corpo}`).digest("base64");
    const enviar = (sig: string) =>
      chamar("/webhooks/fathom", {
        method: "POST",
        headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig },
        body: corpo,
      });

    expect((await enviar("v1,assinaturaerrada")).status).toBe(401);
    const primeira = await enviar(`v1,${assinatura}`);
    expect(primeira.status).toBe(202);
    expect(primeira.corpo).toMatchObject({ recebida: true, nova: true });
    expect((await enviar(`v1,${assinatura}`)).corpo).toMatchObject({ nova: false });
  });

  it("gera token do conector mostrando o valor uma única vez", async () => {
    const r = await chamar("/conector/tokens", { method: "POST", token, json: { nome: "Claude do Leo" } });
    expect(r.corpo.token).toMatch(/^cbr_/);
    const lista = await chamar("/conector/tokens", { token });
    expect(JSON.stringify(lista.corpo)).not.toContain(r.corpo.token);
  });
});
