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
  // Voz falsa que entrega o áudio em dois pedaços, com um intervalo entre eles.
  ctx.fala = {
    nome: "falsa",
    falar: async () => new Uint8Array([7]),
    falarFluxo: async () =>
      (async function* () {
        yield new Uint8Array([1, 2, 3]);
        await new Promise((r) => setTimeout(r, 30));
        yield new Uint8Array([4, 5]);
      })(),
  };
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

  it("voz em fluxo: prepara com login e o áudio sai pelo id, sem login", async () => {
    expect((await chamar("/argos/falar/preparar", { method: "POST", json: { texto: "Oi" } })).status).toBe(401);
    const { corpo } = await chamar("/argos/falar/preparar", { method: "POST", token, json: { texto: "Bom dia, tudo certo." } });
    const res = await fetch(`${base}/argos/falar/${corpo.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    expect((await fetch(`${base}/argos/falar/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await fetch(`${base}/argos/falar/nao-e-id`)).status).toBe(400);
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

describe("API externa (Prospect Team)", () => {
  let token: string;
  let cbr: string;
  const externo = (caminho: string, init: RequestInit & { json?: unknown } = {}) =>
    chamar(`/externo${caminho}`, { ...init, token: cbr, headers: { "x-sistema": "Prospect Team", ...(init.headers ?? {}) } });

  beforeAll(async () => {
    const r = await chamar("/auth/entrar", { method: "POST", json: { email: "admin@tutts.com.br", senha: "senhaForte123" } });
    token = r.corpo.tokenAcesso;
    cbr = (await chamar("/conector/tokens", { method: "POST", token, json: { nome: "Prospect Team", uso: "sistema" } })).corpo.token;
    const criar = (json: unknown) => chamar("/registros", { method: "POST", token, json });
    await criar({
      tipo: "politica",
      titulo: "Tom de voz da marca Tutts",
      conteudo: "Falamos direto com o lojista de autopeças. Contato comercial: vendas@tutts.com.br ou (71) 99999-1234.",
      area: "marketing",
      publicar: true,
    });
    await criar({ tipo: "nota", titulo: "Margem secreta da marca", conteudo: "Margem da marca é 42% e não sai daqui.", area: "marketing", confidencialidade: "restrito", publicar: true });
    await criar({ tipo: "nota", titulo: "Rascunho sobre a marca", conteudo: "Ideia ainda não aprovada sobre a marca.", area: "marketing" });
  });

  it("recusa sem token, com token inválido, com login de tela e com o token do Claude", async () => {
    expect((await chamar("/externo/saude")).status).toBe(401);
    expect((await chamar("/externo/saude", { token: "cbr_nao_existe" })).status).toBe(401);
    expect((await chamar("/externo/saude", { token })).status).toBe(401);
    const doClaude = (await chamar("/conector/tokens", { method: "POST", token, json: { nome: "Claude" } })).corpo.token;
    expect((await chamar("/externo/saude", { token: doClaude })).status).toBe(401);
  });

  it("mostra o cartão de outros sistemas e separa os tokens por uso", async () => {
    const lista = (await chamar("/conector/tokens", { token })).corpo as { nome: string; uso: string }[];
    expect(lista.find((t) => t.nome === "Prospect Team")?.uso).toBe("sistema");
    const status = (await chamar("/integracoes", { token })).corpo as { nome: string; estado: string }[];
    expect(status.find((s) => s.nome === "sistemas")).toBeTruthy();
  });

  it("testa a conexão e diz de quem é o token", async () => {
    const r = await externo("/saude");
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ ok: true, usuario: { nome: "Admin" }, pode: { buscar: true, guardarRascunho: true } });
  });

  it("busca só o que vale e não é restrito, com dados pessoais mascarados", async () => {
    const r = await externo("/buscar", { method: "POST", json: { pergunta: "marca" } });
    expect(r.status).toBe(200);
    const titulos = r.corpo.itens.map((i: { titulo: string }) => i.titulo);
    expect(titulos).toContain("Tom de voz da marca Tutts");
    expect(titulos).not.toContain("Margem secreta da marca");
    expect(titulos).not.toContain("Rascunho sobre a marca");
    const tudo = JSON.stringify(r.corpo);
    expect(tudo).not.toContain("vendas@tutts.com.br");
    expect(tudo).not.toContain("99999-1234");
    expect(r.corpo.itens[0].link).toMatch(/^http:\/\/web\.teste\/registros\//);
  });

  it("anota como lacuna o que não acha", async () => {
    const r = await externo("/buscar", { method: "POST", json: { pergunta: "zebra listrada voadora" } });
    expect(r.corpo).toEqual({ itens: [], lacuna: true });
  });

  it("lê o registro inteiro mascarado e esconde restrito e rascunho", async () => {
    const lista = (await chamar("/registros?porPagina=50", { token })).corpo.itens as { codigo: string; titulo: string }[];
    const codigoDe = (t: string) => lista.find((x) => x.titulo === t)!.codigo;
    const tom = await externo(`/registros/${codigoDe("Tom de voz da marca Tutts")}`);
    expect(tom.status).toBe(200);
    expect(tom.corpo.conteudo).toContain("lojista de autopeças");
    expect(tom.corpo.conteudo).toContain("[EMAIL_1]");
    expect(tom.corpo.conteudo).not.toContain("vendas@tutts.com.br");
    expect((await externo(`/registros/${codigoDe("Margem secreta da marca")}`)).status).toBe(404);
    expect((await externo(`/registros/${codigoDe("Rascunho sobre a marca")}`)).status).toBe(404);
    expect((await externo("/registros/nada")).status).toBe(400);
  });

  it("guarda aprendizado como rascunho, sem duplicar pelo idExterno", async () => {
    const corpo = {
      titulo: "Aprendizados do Instagram — semana 45",
      conteudo: "Carrosséis com antes e depois tiveram o dobro de salvamentos.",
      idExterno: "aprendizados-2026-W45",
    };
    const primeira = await externo("/rascunhos", { method: "POST", json: corpo });
    expect(primeira.status).toBe(201);
    expect(primeira.corpo).toMatchObject({ status: "rascunho", jaExistia: false });
    const segunda = await externo("/rascunhos", { method: "POST", json: corpo });
    expect(segunda.status).toBe(200);
    expect(segunda.corpo).toMatchObject({ codigo: primeira.corpo.codigo, jaExistia: true });

    const registro = (await chamar(`/registros/${primeira.corpo.codigo}`, { token })).corpo;
    expect(registro).toMatchObject({ status: "rascunho", origem: "externo", area: "marketing", tipo: "nota" });
    expect(registro.conteudo).toContain("Enviado por Prospect Team.");
  });

  it("não deixa sistema de fora criar regra nem publicar", async () => {
    const r = await externo("/rascunhos", { method: "POST", json: { tipo: "politica", titulo: "Nova regra", conteudo: "Tentando criar regra de fora." } });
    expect(r.status).toBe(400);
    const p = await externo("/rascunhos", { method: "POST", json: { titulo: "Publica já", conteudo: "Pedindo para publicar direto.", publicar: true } });
    expect(p.status).toBe(201);
    expect(p.corpo.status).toBe("rascunho");
  });

  it("token de quem foi desativado para de funcionar", async () => {
    const novo = await chamar("/usuarios", { method: "POST", token, json: { nome: "Saiu", email: "saiu@tutts.com.br", senha: "senhaForte123", papel: "membro" } });
    expect(novo.status).toBe(201);
    const entrar = await chamar("/auth/entrar", { method: "POST", json: { email: "saiu@tutts.com.br", senha: "senhaForte123" } });
    const dele = (await chamar("/conector/tokens", { method: "POST", token: entrar.corpo.tokenAcesso, json: { nome: "PT", uso: "sistema" } })).corpo.token;
    expect((await chamar("/externo/saude", { token: dele })).status).toBe(200);
    await chamar(`/usuarios/${novo.corpo.id}`, { method: "PATCH", token, json: { ativo: false } });
    expect((await chamar("/externo/saude", { token: dele })).status).toBe(401);
  });
});
