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
  nome_prof varchar, data_solicitado date, valor numeric, valor_prof numeric, dentro_prazo boolean, tempo_execucao_minutos int, ocorrencia varchar);
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
  (2, 2, 8, 'Rede Beta', (now() AT TIME ZONE 'America/Bahia')::date, 50, 30, true, 30, null);
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
    expect(r.totais).toMatchObject({ entregas: 3, os: 2, fora_prazo: 1, retornos: 1 });
  });

  it("faturamento não duplica os valores repetidos por ponto", async () => {
    const r = await consultaPronta("faturamento")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ cobrado: 80, pago_motoboys: 48, faturamento: 32, os: 2 });
  });

  it("saques em aberto excluem pagos e rejeitados", async () => {
    const r = await consultaPronta("saques")!.executar(leitura, {});
    expect(r.totais).toMatchObject({ pedidos_em_aberto: 2, valor_em_aberto: 245, pagos: 1 });
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
