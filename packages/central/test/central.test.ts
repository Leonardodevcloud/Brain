import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarPool, type Pool } from "@cerebro/db";
import {
  carregarCatalogo,
  consultaPronta,
  consultar,
  criarPoolLeitura,
  ehColunaPessoal,
  sincronizarAcesso,
  validarSql,
  ClienteApiCentral,
  ENDPOINTS_CENTRAL,
  lerRespostaCentral,
  limparSensiveis,
  type PoolLeitura,
} from "../src/index.js";

const URL_TESTE = process.env.DATABASE_URL_TESTE ?? "postgres://cerebro:cerebro@localhost:5432/cerebro_teste";
const SENHA = "senha_de_teste_do_argos_123456";
let dono: Pool;
let leitura: PoolLeitura;

// Um pedaço da Central, com as mesmas colunas das tabelas reais.
const CENTRAL = `
SET search_path = public;
DROP TABLE IF EXISTS disponibilidade_linhas, disponibilidade_lojas, disponibilidade_regioes, bi_entregas,
  withdrawal_requests, user_financial_data, refresh_tokens CASCADE;
CREATE TABLE disponibilidade_regioes (id serial PRIMARY KEY, nome varchar(100), gestores varchar(255));
CREATE TABLE disponibilidade_lojas (id serial PRIMARY KEY, regiao_id int REFERENCES disponibilidade_regioes(id), codigo varchar(20), nome varchar(200));
CREATE TABLE disponibilidade_linhas (id serial PRIMARY KEY, loja_id int REFERENCES disponibilidade_lojas(id), cod_profissional varchar(50),
  nome_profissional varchar(200), status varchar(20) DEFAULT 'A CONFIRMAR', is_excedente boolean DEFAULT false, is_reposicao boolean DEFAULT false);
CREATE TABLE bi_entregas (id serial PRIMARY KEY, os int, ponto int, cod_cliente int, nome_fantasia varchar, centro_custo varchar, cod_prof int,
  nome_prof varchar, data_solicitado date, valor numeric, valor_prof numeric, dentro_prazo boolean, tempo_execucao_minutos int, ocorrencia varchar,
  os_concluida boolean, finalizado timestamp, data_hora timestamp, data_hora_alocado timestamp, data_chegada date, hora_chegada varchar,
  dentro_prazo_prof boolean, tempo_entrega_prof_minutos int);
CREATE TABLE withdrawal_requests (id serial PRIMARY KEY, user_cod varchar, user_name varchar, cpf varchar, pix_key varchar,
  requested_amount numeric, fee_amount numeric, final_amount numeric, status varchar, created_at timestamp DEFAULT now(), approved_at timestamp);
CREATE TABLE user_financial_data (id serial PRIMARY KEY, user_cod varchar, full_name varchar, cpf varchar, pix_key varchar);
CREATE TABLE refresh_tokens (id serial PRIMARY KEY, token varchar);

INSERT INTO disponibilidade_regioes (nome) VALUES ('Salvador'), ('Maceió');
INSERT INTO disponibilidade_lojas (regiao_id, codigo, nome) VALUES (1, 'L1', 'Loja Centro'), (1, 'L2', 'Loja Norte'), (2, 'L3', 'Loja Maceió');
INSERT INTO disponibilidade_linhas (loja_id, cod_profissional, nome_profissional, status, is_excedente) VALUES
  (1, '10', 'Ana', 'EM LOJA', false), (1, '11', 'Beto', 'CONFIRMADO', false), (1, '', null, 'A CONFIRMAR', false),
  (2, '12', 'Caio', 'FALTANDO', false), (2, '13', 'Duda', 'EM LOJA', false), (2, '14', 'Extra', 'EM LOJA', true),
  (3, '15', 'Elis', 'SEM CONTATO', false), (3, '16', 'Fábio', 'EM LOJA', false);
-- OS 1: coleta + 2 entregas (valores repetidos em cada ponto, como na Central)
INSERT INTO bi_entregas (os, ponto, cod_cliente, nome_fantasia, data_solicitado, valor, valor_prof, dentro_prazo, tempo_execucao_minutos, ocorrencia) VALUES
  (1, 1, 7, 'Autopeças Alfa', (now() AT TIME ZONE 'America/Bahia')::date, 30, 18, null, null, null),
  (1, 2, 7, 'Autopeças Alfa', (now() AT TIME ZONE 'America/Bahia')::date, 30, 18, true, 40, null),
  (1, 3, 7, 'Autopeças Alfa', (now() AT TIME ZONE 'America/Bahia')::date, 30, 18, false, 95, 'Retorno - cliente ausente'),
  (2, 2, 8, 'Rede Beta', (now() AT TIME ZONE 'America/Bahia')::date, 50, 30, true, 30, null),
  -- OS 3 ainda em andamento: o BI da Central não conta
  (3, 2, 8, 'Rede Beta', (now() AT TIME ZONE 'America/Bahia')::date, 99, 60, null, null, null);
UPDATE bi_entregas SET os_concluida = (os <> 3), finalizado = CASE WHEN os <> 3 THEN data_solicitado + time '10:00' END,
  data_hora = data_solicitado + time '09:00', cod_prof = CASE WHEN os = 1 THEN 10 ELSE 11 END, nome_prof = CASE WHEN os = 1 THEN 'Ana' ELSE 'Beto' END,
  dentro_prazo_prof = CASE WHEN ponto >= 2 AND os <> 3 THEN (ponto <> 3) END, tempo_entrega_prof_minutos = CASE WHEN ponto >= 2 AND os <> 3 THEN 20 END;
-- Coleta da OS 1: pedido às 09:00, alocado 09:10, chegou na loja 09:30
UPDATE bi_entregas SET data_hora_alocado = data_solicitado + time '09:10', data_chegada = data_solicitado, hora_chegada = '09:30' WHERE os = 1 AND ponto = 1;
-- OS 4 antiga: pedido às 18:00 de sexta, finalizada às 08:40 do dia seguinte → 40 min pela regra das 17h
INSERT INTO bi_entregas (os, ponto, cod_cliente, nome_fantasia, data_solicitado, dentro_prazo, os_concluida, data_hora, finalizado) VALUES
  (4, 2, 9, 'Loja Gama', '2020-01-10', true, true, '2020-01-10 18:00', '2020-01-11 08:40');
-- Cliente 767 em 03/02/2020: Rui (BR Auto Parts Brasília) fez 2 OS, Lia (Comollati Brasília) 1, Goiânia fica fora
INSERT INTO bi_entregas (os, ponto, cod_cliente, nome_fantasia, centro_custo, cod_prof, nome_prof, data_solicitado, valor_prof, os_concluida, finalizado) VALUES
  (10, 2, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui', '2020-02-03', 30, true, '2020-02-03 10:00'),
  (10, 3, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui', '2020-02-03', 30, true, '2020-02-03 10:30'),
  (11, 2, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui', '2020-02-03', 42.70, true, '2020-02-03 12:00'),
  (12, 2, 767, 'Grupo Comollati', 'COMOLLATI BRASÍLIA', 22, 'Lia', '2020-02-03', 180, true, '2020-02-03 12:00'),
  (13, 2, 767, 'Grupo Comollati', 'COMOLLATI GOIANIA', 23, 'Teo', '2020-02-03', 50, true, '2020-02-03 12:00'),
  (14, 2, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui', '2020-02-03', 99, false, null);
INSERT INTO withdrawal_requests (user_cod, user_name, cpf, pix_key, requested_amount, fee_amount, final_amount, status) VALUES
  ('10', 'Ana', '123.456.789-09', 'ana@pix', 200, 5, 195, 'aguardando_aprovacao'),
  ('11', 'Beto', '987.654.321-00', 'beto@pix', 100, 5, 95, 'pago'),
  ('12', 'Caio', '111.222.333-44', 'caio@pix', 50, 0, 50, 'processando');
INSERT INTO user_financial_data (user_cod, full_name, cpf, pix_key) VALUES ('10', 'Ana', '123', 'x');
`;

beforeAll(async () => {
  dono = criarPool({ url: URL_TESTE, max: 2 });
  await dono.query(CENTRAL);
  await dono.query("CREATE SCHEMA IF NOT EXISTS cerebro");
  leitura = criarPoolLeitura(URL_TESTE, SENHA);
});

afterAll(async () => {
  await leitura.end();
  await dono.query("DROP SCHEMA IF EXISTS argos CASCADE");
  await dono.end();
});

describe("política de dados pessoais", () => {
  it("reconhece colunas pessoais sem pegar falsos positivos", () => {
    for (const c of ["cpf", "pix_key", "senha_hash", "tutts_token_api", "conta_corrente", "agencia", "placa", "data_nascimento", "api_key"]) {
      expect(ehColunaPessoal(c), c).toBe(true);
    }
    for (const c of ["contato", "valor", "nome_prof", "status", "telefone", "requested_amount", "conciliacao_omie", "placar"]) {
      expect(ehColunaPessoal(c), c).toBe(false);
    }
  });
});

describe("sincronização do acesso", () => {
  it("cria o usuário somente leitura e as views sem colunas pessoais", async () => {
    const r = await sincronizarAcesso(dono, SENHA);
    expect(r.tabelasBloqueadas).toEqual(expect.arrayContaining(["user_financial_data", "refresh_tokens"]));
    expect(r.colunasOcultas).toBeGreaterThanOrEqual(2); // cpf e pix_key dos saques

    const { rows } = await leitura.query(`SELECT * FROM withdrawal_requests ORDER BY id`);
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!)).not.toContain("cpf");
    expect(Object.keys(rows[0]!)).not.toContain("pix_key");
    expect(rows[0]).toMatchObject({ user_name: "Ana", status: "aguardando_aprovacao" });
  });

  it("é idempotente (roda de novo sem erro)", async () => {
    await expect(sincronizarAcesso(dono, SENHA)).resolves.toBeTruthy();
  });

  it("o banco impede tudo que não seja ler as views", async () => {
    await expect(leitura.query(`SELECT * FROM public.withdrawal_requests`)).rejects.toThrow(/permission denied/);
    await expect(leitura.query(`SELECT * FROM user_financial_data`)).rejects.toThrow(/does not exist/);
    await expect(leitura.query(`SELECT * FROM cerebro.registros`)).rejects.toThrow();
    await expect(leitura.query(`INSERT INTO withdrawal_requests (user_name) VALUES ('x')`)).rejects.toThrow(/read-only|permission/);
    await expect(leitura.query(`CREATE TABLE argos.x (id int)`)).rejects.toThrow();
  });

  it("corta consultas longas", async () => {
    await expect(consultar(leitura, "SELECT 1 FROM (SELECT pg_sleep(2)) s", [], { timeoutMs: 300 })).rejects.toThrow(/statement timeout|canceling/);
  });
});

describe("validação do SQL gerado", () => {
  it("aceita leitura e recusa o resto", () => {
    expect(validarSql("SELECT status, COUNT(*) FROM withdrawal_requests GROUP BY 1;")).not.toMatch(/;$/);
    expect(validarSql("WITH x AS (SELECT 1) SELECT * FROM x")).toBeTruthy();
    expect(validarSql("SELECT * FROM bi_entregas WHERE ocorrencia ILIKE '%pedido delete%'")).toBeTruthy();
    for (const ruim of [
      "DELETE FROM bi_entregas",
      "SELECT 1; DROP TABLE x",
      "UPDATE bi_entregas SET valor = 0",
      "SELECT pg_sleep(10)",
      "SELECT * FROM public.withdrawal_requests",
      "SELECT * FROM pg_roles",
      "SELECT set_config('x','y',false)",
    ]) {
      expect(() => validarSql(ruim), ruim).toThrow();
    }
  });
});

describe("consultas prontas", () => {
  it("disponibilidade conta só titulares e calcula % em loja", async () => {
    const r = await consultaPronta("disponibilidade")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ titulares: 7, em_loja: 3, confirmados: 1, faltando: 1, sem_contato: 1, vagas_abertas: 1 });
    expect(r.totais.pct_em_loja).toBe(42.9);
    const ssa = await consultaPronta("disponibilidade")!.executar(leitura, { regiao: "salva", por: "loja" });
    expect(ssa.linhas.map((l) => l.loja).sort()).toEqual(["Loja Centro", "Loja Norte"]);
  });

  it("entregas de hoje ignoram a coleta e calculam o SLA", async () => {
    const r = await consultaPronta("entregas")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ entregas: 3, os: 2, no_prazo: 2, fora_prazo: 1, sla_pct: 66.7, os_com_retorno: 1 });
  });

  it("tempos usam a regra das 17h da Central", async () => {
    const hoje = await consultaPronta("tempos")!.executar(leitura, { cliente: "alfa" });
    expect(hoje.linhas[0]).toMatchObject({ alocacao_min: "10.0", coleta_min: "20.0", entrega_min: "60.0" });
    const ontem = await consultaPronta("tempos")!.executar(leitura, { cliente: "gama", inicio: "2020-01-01", fim: "2020-01-31" });
    expect(Number(ontem.linhas[0]!.entrega_min)).toBe(40);
  });

  it("profissionais usam o prazo do motoboy (da coleta à finalização)", async () => {
    const r = await consultaPronta("profissionais")!.executar(leitura, { ordem: "piores" });
    expect(r.linhas[0]).toMatchObject({ profissional: "Ana", entregas: 2, fora_prazo_prof: 1 });
    expect(r.totais).toMatchObject({ motoboys: 2, entregas: 3, prazo_prof_pct: 66.7 });
  });

  it("margem por motoboy: cada motoboy conta uma vez no dia, só nos centros da regra", async () => {
    const r = await consultaPronta("margem_por_motoboy")!.executar(leitura, {
      cod_cliente: 767, centros: ["br auto brasilia", "comollati brasilia"], receita_dia: 250, custo_dia: 80, inicio: "2020-02-03",
    });
    expect(r.linhas.map((l) => [l.profissional, l.os, Number(l.valor_motoboy), Number(l.lucro)])).toEqual([
      ["Rui", 2, 72.7, 97.3],
      ["Lia", 1, 180, -10],
    ]);
    expect(r.totais).toMatchObject({ motoboys_dia: 2, os: 3, receita: 500, custo_moto: 160, pago_motoboys: 252.7, lucro: 87.3, margem_pct: 17.5, motoboys_negativos: 1 });
    await expect(consultaPronta("margem_por_motoboy")!.executar(leitura, { receita_dia: 250 })).rejects.toThrow(/cod_cliente/);
  });

  it("faturamento não duplica os valores repetidos por ponto", async () => {
    const r = await consultaPronta("faturamento")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ cobrado: 80, pago_motoboys: 48, faturamento: 32, os: 2 });
  });

  it("saques em aberto excluem pagos e rejeitados", async () => {
    const r = await consultaPronta("saques")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ pedidos_em_aberto: 2, valor_em_aberto: 245, pagos: 1, pedidos: 3, motoboys: 3 });
  });

  it("saques de um dia específico, com motoboys distintos", async () => {
    const hoje = (await dono.query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Bahia')::date, 'YYYY-MM-DD') AS d`)).rows[0]!.d;
    const r = await consultaPronta("saques")!.executar(leitura, { inicio: hoje });
    expect(r.titulo).toBe(`Saques de ${hoje}`);
    expect(r.totais).toMatchObject({ pedidos: 3, motoboys: 3 });
    const vazio = await consultaPronta("saques")!.executar(leitura, { inicio: "2020-01-01" });
    expect(vazio.totais).toMatchObject({ pedidos: 0, motoboys: 0 });
  });
});

describe("catálogo", () => {
  it("lista o que o Argos enxerga, com módulo e descrição", async () => {
    const c = await carregarCatalogo(leitura);
    const nomes = c.map((t) => t.nome);
    expect(nomes).toEqual(expect.arrayContaining(["bi_entregas", "disponibilidade_linhas", "withdrawal_requests"]));
    expect(nomes).not.toContain("user_financial_data");
    const saques = c.find((t) => t.nome === "withdrawal_requests")!;
    expect(saques.modulo).toBe("financial");
    expect(saques.colunas.map((x) => x.nome)).not.toContain("cpf");
  });
});

describe("API da Central (só leitura)", () => {
  let servidor: import("node:http").Server;
  let url = "";
  const pedidos: { metodo: string; caminho: string; segredo: string | undefined }[] = [];

  beforeAll(async () => {
    const http = await import("node:http");
    servidor = http.createServer((req, res) => {
      pedidos.push({ metodo: req.method ?? "", caminho: req.url ?? "", segredo: req.headers["x-internal-secret"] as string | undefined });
      if (req.headers["x-internal-secret"] !== "segredo-de-teste-123") {
        res.writeHead(401).end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/bi/dashboard-completo")) {
        res.end(
          JSON.stringify({
            metricas: { total_entregas: 120, taxa_prazo: 91.5, valor_total: 4500.5 },
            porCliente: [{ cod_cliente: 7, nome_cliente: "Autopeças Alfa", entregas: 80, taxa_prazo: 95, contato: { telefone: "71999990000", cidade: "Salvador" } }],
            porProfissional: [{ cod_prof: 10, nome_prof: "Ana", cpf: "123.456.789-09", chave_pix: "ana@pix", entregas: 50 }],
          }),
        );
        return;
      }
      res.end(JSON.stringify([{ id: 1, nome: "Salvador" }]));
    });
    await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(servidor.address() as import("node:net").AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => servidor.close(() => r())));

  it("chama só GET, com o segredo, e tira os dados pessoais da resposta", async () => {
    const api = new ClienteApiCentral({ url, segredo: "segredo-de-teste-123" });
    const r = await api.consultar("bi.dashboard", { data_inicio: "2026-10-01", data_fim: "2026-10-28", inventado: "x", cod_cliente: [7, 8] });
    const ultimo = pedidos.at(-1)!;
    expect(ultimo).toMatchObject({ metodo: "GET", segredo: "segredo-de-teste-123" });
    expect(ultimo.caminho).toBe("/api/bi/dashboard-completo?data_inicio=2026-10-01&data_fim=2026-10-28&cod_cliente=7%2C8");
    const texto = JSON.stringify(r.dados);
    expect(texto).not.toMatch(/123\.456|ana@pix|71999990000|cpf|telefone|pix/);
    expect(texto).toContain("Salvador");
    const lido = lerRespostaCentral(r.dados);
    expect(lido.numeros).toMatchObject({ "metricas.taxa_prazo": 91.5 });
    expect(lido.tabelas.map((t) => t.caminho)).toEqual(["porCliente", "porProfissional"]);
    expect(lido.tabelas[0]!.linhas[0]).toMatchObject({ entregas: 80, contato_cidade: "Salvador" });
    // a segunda chamada igual vem do cache
    const antes = pedidos.length;
    await api.consultar("bi.dashboard", { data_inicio: "2026-10-01", data_fim: "2026-10-28", cod_cliente: [7, 8] });
    expect(pedidos.length).toBe(antes);
  });

  it("recusa rota fora da lista, parâmetro obrigatório faltando e data mal escrita", async () => {
    const api = new ClienteApiCentral({ url, segredo: "segredo-de-teste-123" });
    const antes = pedidos.length;
    await expect(api.consultar("bi.apagar_tudo", {})).rejects.toThrow(/não existe/);
    await expect(api.consultar("bi.dashboard", { data_inicio: "2026-10-01" })).rejects.toThrow(/data_fim/);
    await expect(api.consultar("bi.dashboard", { data_inicio: "ontem", data_fim: "2026-10-28" })).rejects.toThrow(/AAAA-MM-DD/);
    expect(pedidos.length).toBe(antes);
    expect(ENDPOINTS_CENTRAL.every((e) => e.caminho.startsWith("/api/"))).toBe(true);
  });

  it("segredo errado vira erro claro", async () => {
    const api = new ClienteApiCentral({ url, segredo: "outro-segredo-qualquer" });
    await expect(api.testar()).rejects.toThrow(/401/);
  });

  it("abre listas dentro das linhas (clientes → semanas), como o comparativo semanal", () => {
    const lido = lerRespostaCentral({
      clientes: [{ nome_fantasia: "ROLEMAR", semanas: [{ periodo: "05/10 - 11/10", total_entregas: 153, ticket_medio: 5.99 }, { periodo: "12/10 - 18/10", total_entregas: 152, ticket_medio: 6.14 }], resumo: { total_semanas: 2 } }],
    });
    const semanas = lido.tabelas.find((t) => t.caminho === "clientes.semanas")!;
    expect(semanas.linhas).toEqual([
      { nome_fantasia: "ROLEMAR", resumo_total_semanas: 2, periodo: "05/10 - 11/10", total_entregas: 153, ticket_medio: 5.99 },
      { nome_fantasia: "ROLEMAR", resumo_total_semanas: 2, periodo: "12/10 - 18/10", total_entregas: 152, ticket_medio: 6.14 },
    ]);
  });

  it("limparSensiveis tira as chaves pessoais em qualquer nível", () => {
    expect(limparSensiveis({ a: [{ pix_key: 1, nome: "x", dados: { agencia: "1", conta: "2", valor: 3 } }] })).toEqual({ a: [{ nome: "x", dados: { valor: 3 } }] });
  });
});
