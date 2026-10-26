import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmissorTokens } from "@cerebro/auth";
import { criarPoolLeitura, sincronizarAcesso } from "@cerebro/central";
import { esquemaCriarRegistro, esquemaPergunta, type AtaDados, type UsuarioDTO } from "@cerebro/core";
import { integracoes, jobs, type Pool } from "@cerebro/db";
import type { ClienteNotion } from "@cerebro/integracoes";
import {
  ATOR_SISTEMA,
  acesso,
  conhecimento,
  fontes,
  indexarRegistro,
  invalidarCacheBusca,
  invalidarCacheMapa,
  atenderFala,
  interpretarRapido,
  transcreverFala,
  montarMapa,
  painel,
  responder,
  type Ator,
  type Contexto,
} from "../src/index.js";
import { EmbeddingsFalsos, IaFalsa, URL_TESTE, bancoLimpo, contextoDeTeste } from "./apoio.js";

let pool: Pool;
let ctx: Contexto;
let admin: UsuarioDTO;
let membro: UsuarioDTO;
let atorAdmin: Ator;
let atorMembro: Ator;
const emissor = new EmissorTokens("s".repeat(40));

const ia = new IaFalsa((p) => {
  if (p.sistema.includes("atas objetivas")) {
    return {
      titulo: "Alinhamento de supervisores",
      resumo: "Discutimos faltas no primeiro turno.",
      decisoes: ["Aviso à loja sempre antes das 8h30"],
      pendencias: [
        { tarefa: "Atualizar o POP de troca em rota", responsavel: "Supervisão SSA", prazo: "2026-10-28" },
        { tarefa: "Avisar as lojas", responsavel: null, prazo: "amanhã" },
      ],
      clientes: ["Loja Centro"],
    };
  }
  if (p.sistema.includes("conhecimento durável")) {
    const texto = p.mensagens[0]!.conteudo;
    return texto.includes("multa")
      ? { relevante: true, tipo: "decisao", titulo: "Multa só sem aviso", conteudo: "Multa apenas quando a falta não foi avisada.", motivo: "Regra nova" }
      : { relevante: false };
  }
  // Resposta com fontes: devolve um marcador para conferir que a máscara é desfeita.
  const marcador = /\[TELEFONE_\d+\]/.exec(p.mensagens[0]!.conteudo)?.[0] ?? "";
  return { resposta: `Realoque o motoboy da janela seguinte [1]. Contato ${marcador}`.trim(), suficiente: true };
});

beforeAll(async () => {
  pool = await bancoLimpo();
  ctx = contextoDeTeste(pool, { ia, embeddings: new EmbeddingsFalsos() });
  admin = await acesso.criarUsuario(ctx, null, { nome: "Admin", email: "admin@tutts.com.br", senha: "senhaForte123", papel: "admin" });
  membro = await acesso.criarUsuario(ctx, null, { nome: "Supervisor", email: "sup@tutts.com.br", senha: "senhaForte456", papel: "membro" });
  atorAdmin = { usuarioId: admin.id, papel: "admin", canal: "web" };
  atorMembro = { usuarioId: membro.id, papel: "membro", canal: "web" };
});

afterAll(async () => {
  await pool.end();
});

const novo = (dados: Record<string, unknown>) => esquemaCriarRegistro.parse(dados);

/** Executa os jobs pendentes de indexação, como o worker faria. */
async function rodarIndexacao() {
  for (;;) {
    const job = await jobs.reservar(pool);
    if (!job) break;
    if (job.tipo === "indexar_registro") await indexarRegistro(ctx, job.payload.registroId as string);
    await jobs.concluir(pool, job.id);
  }
  invalidarCacheBusca();
}

describe("acesso", () => {
  it("entra, renova com rotação e sai", async () => {
    const login = await acesso.entrar(ctx, emissor, { email: "ADMIN@tutts.com.br", senha: "senhaForte123" });
    expect(login.usuario.papel).toBe("admin");
    expect(await emissor.verificarAcesso(login.tokenAcesso)).toMatchObject({ usuarioId: admin.id });

    const renovado = await acesso.renovarSessao(ctx, emissor, login.refreshToken);
    expect(renovado.refreshToken).not.toBe(login.refreshToken);
    await expect(acesso.renovarSessao(ctx, emissor, login.refreshToken)).rejects.toMatchObject({ status: 401 });

    await acesso.sair(ctx, renovado.refreshToken);
    await expect(acesso.renovarSessao(ctx, emissor, renovado.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it("recusa senha errada sem revelar se o e-mail existe", async () => {
    await expect(acesso.entrar(ctx, emissor, { email: "admin@tutts.com.br", senha: "errada" })).rejects.toMatchObject({ status: 401 });
    await expect(acesso.entrar(ctx, emissor, { email: "ninguem@tutts.com.br", senha: "errada" })).rejects.toMatchObject({ status: 401 });
  });

  it("só o administrador cria usuários e senhas fracas são recusadas", async () => {
    await expect(
      acesso.criarUsuario(ctx, atorMembro, { nome: "X", email: "x@tutts.com.br", senha: "senhaForte789", papel: "membro" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      acesso.criarUsuario(ctx, atorAdmin, { nome: "X", email: "x@tutts.com.br", senha: "fraca", papel: "membro" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("autentica o conector do Claude com token pessoal e revoga", async () => {
    const { token, id } = await acesso.criarTokenConector(ctx, atorMembro, "Claude do supervisor");
    expect(await acesso.autenticarConector(ctx, token)).toMatchObject({ usuarioId: membro.id, canal: "mcp" });
    await acesso.revogarTokenConector(ctx, atorMembro, id);
    await expect(acesso.autenticarConector(ctx, token)).rejects.toMatchObject({ status: 401 });
  });
});

describe("registros", () => {
  let popId: string;

  it("cria e publica um POP com código, revisão e versão 1", async () => {
    const r = await conhecimento.criarRegistro(
      ctx,
      atorMembro,
      novo({
        tipo: "pop",
        titulo: "Troca de motoboy em rota",
        conteudo: "Quando faltar motoboy pela manhã, realoque o profissional da janela seguinte e avise a loja antes das 8h30. Telefone da central (71) 98765-4321.",
        publicar: true,
      }),
      { origem: "manual" },
    );
    popId = r.id;
    expect(r).toMatchObject({ codigo: "POP-001", status: "vigente", versao: 1 });
    expect(r.revisarEm).not.toBeNull();
    expect(r.versoes).toHaveLength(1);
  });

  it("membro não publica política, mas pode criar como rascunho", async () => {
    await expect(
      conhecimento.criarRegistro(ctx, atorMembro, novo({ tipo: "politica", titulo: "Multa por atraso", conteudo: "Regras.", publicar: true }), {
        origem: "manual",
      }),
    ).rejects.toMatchObject({ status: 403 });
    const rascunho = await conhecimento.criarRegistro(
      ctx,
      atorMembro,
      novo({ tipo: "politica", titulo: "Multa por atraso", conteudo: "Regras." }),
      { origem: "manual" },
    );
    expect(rascunho.status).toBe("rascunho");
    await expect(conhecimento.aprovarRegistro(ctx, atorMembro, rascunho.id)).rejects.toMatchObject({ status: 403 });
    expect((await conhecimento.aprovarRegistro(ctx, atorAdmin, rascunho.id)).status).toBe("vigente");
  });

  it("edição gera nova versão com motivo", async () => {
    const r = await conhecimento.atualizarRegistro(ctx, atorMembro, popId, {
      conteudo: "Quando faltar motoboy pela manhã, realoque o profissional da janela seguinte e avise a loja antes das 8h30. Telefone da central (71) 98765-4321. Sem substituto em 40 minutos, acione outra praça.",
      motivo: "Prazo para acionar outra praça",
    });
    expect(r.versao).toBe(2);
    expect(r.versoes.map((v) => v.motivo)).toEqual(["Prazo para acionar outra praça", "Criado e publicado"]);
  });

  it("aprovar um registro que substitui outro torna o antigo obsoleto", async () => {
    const novoPop = await conhecimento.criarRegistro(
      ctx,
      atorMembro,
      novo({
        tipo: "pop",
        titulo: "Troca de motoboy em rota v2",
        conteudo: "Nova versão do procedimento.",
        relacoes: [{ destinoId: popId, tipo: "substitui" }],
      }),
      { origem: "manual" },
    );
    await conhecimento.aprovarRegistro(ctx, atorMembro, novoPop.id);
    const antigo = await conhecimento.obterRegistro(ctx, popId);
    expect(antigo.status).toBe("obsoleto");
    expect(antigo.relacoes[0]).toMatchObject({ tipo: "substitui", sentido: "entrada" });
    // Para os próximos testes, o procedimento original volta a valer.
    await pool.query(`UPDATE cerebro.registros SET status = 'vigente' WHERE id = $1`, [popId]);
    await conhecimento.descartarRegistro(ctx, atorAdmin, novoPop.id).catch(() => undefined);
  });

  it("marca como 'revisar' o que venceu", async () => {
    await pool.query(`UPDATE cerebro.registros SET revisar_em = current_date - 1 WHERE id = $1`, [popId]);
    const afetados = await conhecimento.marcarVencidos(ctx);
    expect(afetados.map((a) => a.id)).toContain(popId);
    const r = await conhecimento.confirmarRevisao(ctx, atorMembro, popId);
    expect(r.status).toBe("vigente");
  });
});

describe("busca e resposta", () => {
  it("encontra pelo sentido e responde citando, sem vazar dados pessoais para a IA", async () => {
    await rodarIndexacao();
    const resposta = await responder(
      ctx,
      atorMembro,
      esquemaPergunta.parse({ pergunta: "O que fazer quando falta motoboy pela manhã?" }),
    );
    expect(resposta.lacuna).toBe(false);
    expect(resposta.fontes[0]?.codigo).toBe("POP-001");
    // A IA recebeu o telefone mascarado; a resposta volta com o número real.
    const enviado = ia.pedidos.at(-1)!.mensagens[0]!.conteudo;
    expect(enviado).not.toContain("98765-4321");
    expect(resposta.resposta).toContain("(71) 98765-4321");
  });

  it("pergunta sem base vira lacuna", async () => {
    const resposta = await responder(ctx, atorMembro, esquemaPergunta.parse({ pergunta: "Qual o cardápio do refeitório?" }));
    expect(resposta).toMatchObject({ lacuna: true, resposta: null, fontes: [] });
    const { rows } = await pool.query(`SELECT pergunta FROM cerebro.lacunas`);
    expect(rows.map((r) => r.pergunta)).toContain("Qual o cardápio do refeitório?");
  });
});

describe("reuniões e atas", () => {
  it("transforma a reunião em ata, aprova e cria decisões e tarefas", async () => {
    const recebida = await fontes.registrarReuniao(ctx, {
      externoId: "rec-1",
      titulo: "Alinhamento",
      inicio: new Date("2026-10-26T13:00:00Z"),
      duracaoSeg: 2520,
      url: "https://fathom.video/share/rec-1",
      transcricao: "Ana: precisamos avisar as lojas antes das 8h30.\nBeto: combinado.",
    });
    expect(recebida.nova).toBe(true);
    expect((await fontes.registrarReuniao(ctx, { externoId: "rec-1", titulo: "x", inicio: null, duracaoSeg: null, url: null, transcricao: "y" })).nova).toBe(false);

    const ataId = await fontes.gerarAta(ctx, recebida.id!);
    const ata = await conhecimento.obterRegistro(ctx, ataId);
    expect(ata).toMatchObject({ tipo: "reuniao", status: "rascunho", origem: "reuniao" });
    const dados = ata.dados as unknown as AtaDados;
    expect(dados.decisoes).toHaveLength(1);
    // Prazo que não é data vira null em vez de ir errado para o Notion.
    expect(dados.pendencias.map((p) => p.prazo)).toEqual(["2026-10-28", null]);

    const criadas: string[] = [];
    const notionFalso = {
      criarTarefa: async (_mapa: unknown, t: { titulo: string }) => {
        criadas.push(t.titulo);
        return { id: `p-${criadas.length}`, url: `https://notion.so/p-${criadas.length}` };
      },
    } as unknown as ClienteNotion;
    const ctxNotion = { ...ctx, notion: notionFalso };
    await integracoes.salvar(pool, "notion", { config: { databaseId: "db-1", propTitulo: "Nome" } });

    await conhecimento.aprovarRegistro(ctxNotion, atorAdmin, ataId, { decisoes: [0], pendencias: [0] });
    const aprovada = await conhecimento.obterRegistro(ctx, ataId);
    expect(aprovada.status).toBe("vigente");
    const decisao = aprovada.relacoes.find((r) => r.sentido === "entrada");
    expect(decisao?.registro).toMatchObject({ status: "vigente" });
    expect(decisao?.registro.codigo).toMatch(/^DEC-/);

    await fontes.criarTarefasDaAta(ctxNotion, ataId);
    await fontes.criarTarefasDaAta(ctxNotion, ataId);
    expect(criadas).toEqual(["Atualizar o POP de troca em rota"]);
  });
});

describe("conversas do Claude", () => {
  it("importa só conversas novas e cria rascunho do que é relevante", async () => {
    const conversas = [
      { uuid: "c-1", name: "Regra de multa", chat_messages: [{ sender: "human", text: "Como fica a multa?" }, { sender: "assistant", text: "Decidimos: multa só sem aviso." }] },
      { uuid: "c-2", name: "Receita de bolo", chat_messages: [{ sender: "human", text: "Bolo?" }, { sender: "assistant", text: "Farinha." }] },
    ];
    const zip = zipSync({ "conversations.json": strToU8(JSON.stringify(conversas)) });
    expect(await fontes.importarExportacaoClaude(ctx, atorAdmin, zip)).toMatchObject({ total: 2, novas: 2 });

    const multa = await fontes.extrairConhecimento(ctx, {
      chave: "claude:c-1",
      origem: "conversa",
      titulo: "Regra de multa",
      texto: "Pessoa: Como fica a multa?\n\nClaude: Decidimos: multa só sem aviso.",
      fonteUrl: null,
    });
    expect(multa.resultado).toBe("registro");
    const bolo = await fontes.extrairConhecimento(ctx, { chave: "claude:c-2", origem: "conversa", titulo: "Receita", texto: "Bolo", fonteUrl: null });
    expect(bolo.resultado).toBe("irrelevante");

    const registro = await conhecimento.obterRegistro(ctx, (multa as { registroId: string }).registroId);
    expect(registro).toMatchObject({ tipo: "decisao", status: "rascunho", origem: "importacao" });

    // Reimportar o mesmo arquivo não gera trabalho novo.
    expect(await fontes.importarExportacaoClaude(ctx, atorAdmin, zip)).toMatchObject({ novas: 0, jaVistas: 2 });
  });
});

describe("fila e painel", () => {
  it("reprograma com espera e falha definitivamente na última tentativa", async () => {
    await jobs.enfileirar(pool, "teste", {}, { maxTentativas: 2 });
    let job = await jobs.reservar(pool);
    while (job && job.tipo !== "teste") {
      await jobs.concluir(pool, job.id);
      job = await jobs.reservar(pool);
    }
    expect(await jobs.falhar(pool, job!, "erro 1")).toBe(false);
    await pool.query(`UPDATE cerebro.jobs SET executar_em = now() WHERE id = $1`, [job!.id]);
    const segunda = await jobs.reservar(pool);
    expect(segunda?.tentativas).toBe(2);
    expect(await jobs.falhar(pool, segunda!, "erro 2")).toBe(true);
  });

  it("monta o início e o status das integrações", async () => {
    const inicio = await painel.resumoInicio(ctx);
    expect(inicio.atividade.length).toBeGreaterThan(0);
    const status = await painel.statusIntegracoes(ctx, atorAdmin);
    expect(status.find((s) => s.nome === "deepseek")?.estado).toBe("ativo");
    expect(status.find((s) => s.nome === "email")?.estado).toBe("desligado");
    expect(ATOR_SISTEMA.usuarioId).toBeNull();
  });
});

describe("mapa", () => {
  it("liga registros à área, às relações explícitas e aos parecidos", async () => {
    invalidarCacheMapa();
    const m = await montarMapa(ctx);
    const registros = m.nos.filter((n) => n.categoria === "registro");
    expect(registros.length).toBeGreaterThan(3);
    expect(m.nos.some((n) => n.id === "area:operacoes" && n.rotulo === "Operações")).toBe(true);
    // Toda ponta de ligação existe como nó.
    const ids = new Set(m.nos.map((n) => n.id));
    expect(m.ligacoes.every((l) => ids.has(l.origem) && ids.has(l.destino))).toBe(true);
    // A relação "substitui" criada nos testes de registros aparece.
    expect(m.ligacoes.some((l) => l.tipo === "substitui")).toBe(true);
    // Sem embeddings suficientes, a semelhança é medida pelo texto.
    expect(["texto", "embeddings"]).toContain(m.semelhanca);
    // Registros descartados ficam de fora.
    const { rows } = await pool.query(`SELECT id FROM cerebro.registros WHERE status = 'descartado'`);
    for (const r of rows) expect(ids.has(r.id)).toBe(false);
  });
});

describe("Argos", () => {
  it("entende comandos de tela falados de vários jeitos", () => {
    for (const f of ["Argos, abre o mapa", "pode abrir o mapa pra mim?", "abra o mapa por favor"]) expect(interpretarRapido(f)).toMatchObject({ intencao: "navegar", alvo: "mapa" });
    expect(interpretarRapido("me leva pra biblioteca")).toMatchObject({ intencao: "navegar", alvo: "biblioteca" });
    expect(interpretarRapido("mostra a POP 001 no mapa")).toMatchObject({ intencao: "mapa", alvo: "pop-001" });
    expect(interpretarRapido("qual a loja mais crítica agora")).toMatchObject({ intencao: "dados" });
  });

  it("responde cumprimento pelo nome, sem virar lacuna", async () => {
    const r = await atenderFala({ ...ctx, ia: null }, atorAdmin, "oi, tudo bem ?");
    expect(r.intencao).toBe("conversa");
    expect(r.fala).toMatch(/^(Bom dia|Boa tarde|Boa noite), Admin! Tudo certo por aqui/);
    expect((await atenderFala({ ...ctx, ia: null }, atorAdmin, "valeu")).fala).toMatch(/^Por nada, Admin/);
  });

  const intencao = (dados: object) =>
    new IaFalsa((p) => (p.sistema.includes("assistente de voz") ? { alvo: null, tipo: null, titulo: null, conteudo: null, fala: null, ...dados } : { resposta: "Realoque o motoboy [1].", suficiente: true }));

  it("entende comandos óbvios sem precisar da IA", async () => {
    const semIa = { ...ctx, ia: null };
    const r = await atenderFala(semIa, atorMembro, "Argos, abre o mapa");
    expect(r).toMatchObject({ intencao: "navegar", acao: { destino: "/mapa", automatica: true } });
    expect(interpretarRapido("o que tem para revisar hoje?")?.intencao).toBe("pendencias");
    const p = await atenderFala(semIa, atorMembro, "o que eu tenho pra aprovar?");
    expect(p.intencao).toBe("pendencias");
    expect(p.fala).toMatch(/aprovar|em dia/);
  });

  it("responde perguntas com uma fala curta, sem as citações", async () => {
    const r = await atenderFala({ ...ctx, ia: intencao({ intencao: "perguntar" }) }, atorMembro, "como tratamos falta de motoboy pela manhã?");
    expect(r.intencao).toBe("perguntar");
    expect(r.fala).toBe("Realoque o motoboy.");
    expect(r.fontes.length).toBeGreaterThan(0);
    expect(r.acao?.destino).toMatch(/^\/registros\//);
  });

  it("salva o que foi ditado sempre como rascunho", async () => {
    const ia = intencao({ intencao: "rascunho", tipo: "decisao", titulo: "Coleta só até 17h", conteudo: "A partir de novembro, coletas só até 17h." });
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "salva como decisão: a partir de novembro coleta só até 17h");
    expect(r.intencao).toBe("rascunho");
    const id = r.acao!.destino.split("/").pop()!;
    const reg = await conhecimento.obterRegistro(ctx, id);
    expect(reg).toMatchObject({ tipo: "decisao", status: "rascunho", titulo: "Coleta só até 17h" });
    expect(reg.dados).toMatchObject({ via: "voz" });
  });

  it("abre um registro pelo código falado", async () => {
    const r = await atenderFala({ ...ctx, ia: intencao({ intencao: "abrir", alvo: "pop 1" }) }, atorMembro, "abre o pop 1");
    expect(r.acao?.destino).toBe("/registros/POP-001");
  });

  it("transcreve com o provedor de voz e recusa áudio vazio", async () => {
    const voz = { nome: "falsa", transcrever: async () => " abre o mapa " };
    expect(await transcreverFala({ ...ctx, voz }, new Uint8Array(5000), "audio/webm")).toBe("abre o mapa");
    await expect(transcreverFala({ ...ctx, voz }, new Uint8Array(10), "audio/webm")).rejects.toMatchObject({ status: 400 });
    await expect(transcreverFala({ ...ctx, voz: null }, new Uint8Array(5000), "audio/webm")).rejects.toMatchObject({ status: 503 });
  });
});

describe("Argos consultando a Central", () => {
  let leitura: ReturnType<typeof criarPoolLeitura>;
  const SENHA = "senha_de_teste_do_argos_123456";

  beforeAll(async () => {
    await pool.query(`
      SET search_path = public;
      DROP TABLE IF EXISTS disponibilidade_linhas, disponibilidade_lojas, disponibilidade_regioes, bi_entregas CASCADE;
      CREATE TABLE disponibilidade_regioes (id serial PRIMARY KEY, nome varchar(100));
      CREATE TABLE disponibilidade_lojas (id serial PRIMARY KEY, regiao_id int, codigo varchar(20), nome varchar(200));
      CREATE TABLE disponibilidade_linhas (id serial PRIMARY KEY, loja_id int, cod_profissional varchar(50), nome_profissional varchar(200),
        status varchar(20), is_excedente boolean DEFAULT false, is_reposicao boolean DEFAULT false);
      CREATE TABLE bi_entregas (id serial PRIMARY KEY, os int, ponto int, nome_fantasia varchar, nome_prof varchar, data_solicitado date,
        dentro_prazo boolean, valor numeric, valor_prof numeric);
      INSERT INTO disponibilidade_regioes (nome) VALUES ('Salvador');
      INSERT INTO disponibilidade_lojas (regiao_id, codigo, nome) VALUES (1, 'L1', 'Loja Centro');
      INSERT INTO disponibilidade_linhas (loja_id, cod_profissional, nome_profissional, status) VALUES
        (1, '10', 'Ana Souza', 'EM LOJA'), (1, '11', 'Beto Lima', 'FALTANDO'), (1, '12', 'Caio Reis', 'EM LOJA'), (1, '', null, 'A CONFIRMAR');
      INSERT INTO bi_entregas (os, ponto, nome_fantasia, nome_prof, data_solicitado, dentro_prazo) VALUES
        (1, 2, 'Rede Alfa', 'Ana Souza', current_date, true), (2, 2, 'Rede Alfa', 'Beto Lima', current_date, false), (3, 2, 'Rede Beta', 'Ana Souza', current_date, true);
      SET search_path = "$user", public;
    `);
    await sincronizarAcesso(pool, SENHA);
    leitura = criarPoolLeitura(URL_TESTE, SENHA);
  });

  afterAll(async () => {
    await leitura.end();
  });

  it("responde a disponibilidade sem IA, com a consulta pronta", async () => {
    const r = await atenderFala({ ...ctx, ia: null, central: leitura }, atorAdmin, "Argos, como está a disponibilidade agora?");
    expect(r.intencao).toBe("dados");
    expect(r.dados?.origem).toBe("pronta");
    expect(r.dados?.totais).toMatchObject({ titulares: 4, em_loja: 2, faltando: 1, vagas_abertas: 1, pct_em_loja: 50 });
    expect(r.fala).toMatch(/2 motoboys em loja de 4/);
  });

  it("entende fala com erro de transcrição e aponta a loja com mais faltas", async () => {
    const r = await atenderFala({ ...ctx, ia: null, central: leitura }, atorAdmin, "como ta a usponiblidade hoje ? qual loja esta com mais faltas ?");
    expect(r.intencao).toBe("dados");
    expect(r.dados?.titulo).toBe("Lojas com mais faltas agora");
    expect(r.fala).toMatch(/A loja com mais faltas é Loja Centro, com 1 faltando/);
  });

  it("filtra a região falada, sem acento e sem caixa", async () => {
    const c = { ...ctx, ia: null, central: leitura };
    const r = await atenderFala(c, atorAdmin, "como está a disponibilidade em salvador?");
    expect(r.dados?.totais).toMatchObject({ titulares: 4, em_loja: 2 });
    expect(r.dados?.colunas).toContain("loja");
    expect(r.fala).toMatch(/^Em Salvador, agora são 2/);
    const nada = await atenderFala(c, atorAdmin, "disponibilidade em Maceió");
    expect(nada.fala).toMatch(/Não encontrei a região Maceio/);
  });

  it("sem acesso configurado, explica o que falta", async () => {
    const r = await atenderFala({ ...ctx, ia: null, central: null }, atorAdmin, "como está a disponibilidade agora?");
    expect(r.fala).toMatch(/ARGOS_DB_SENHA/);
  });

  it("pergunta livre: a IA escolhe as tabelas, escreve o SQL, corrige o erro e analisa sem ver nomes", async () => {
    let tentativasSql = 0;
    const ia = new IaFalsa((p) => {
      if (p.sistema.includes("assistente de voz")) return { intencao: "dados", alvo: null, tipo: null, titulo: null, conteudo: null, fala: null };
      if (p.sistema.includes("planeja como responder")) return { ferramenta: "sql", parametros: {}, tabelas: ["bi_entregas", "tabela_que_nao_existe"] };
      if (p.sistema.includes("escreve UMA consulta SQL")) {
        tentativasSql++;
        return tentativasSql === 1
          ? { sql: "SELECT nome_errado FROM bi_entregas", explicacao: "erro proposital" }
          : {
              sql: "SELECT nome_prof AS motoboy, COUNT(*) AS entregas FROM bi_entregas WHERE COALESCE(ponto,1) >= 2 GROUP BY 1 ORDER BY 2 DESC",
              explicacao: "Entregas por motoboy",
            };
      }
      if (p.sistema.includes("resultado de uma consulta")) {
        const conteudo = p.mensagens[0]!.conteudo;
        expect(conteudo).not.toContain("Ana Souza"); // nomes de pessoas vão mascarados
        const marcador = /\[PESSOA_\d+\]/.exec(conteudo)?.[0] ?? "?";
        return { fala: `${marcador} lidera com 2 entregas.`, analise: "- Ritmo bom.", destaques: [{ rotulo: "Líder", valor: marcador }] };
      }
      return {};
    });
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "quem mais entregou hoje?");
    expect(tentativasSql).toBe(2);
    expect(r.dados).toMatchObject({ origem: "livre", tabelas: ["bi_entregas"] });
    expect(r.dados?.linhas[0]).toMatchObject({ motoboy: "Ana Souza" });
    expect(r.fala).toBe("Ana Souza lidera com 2 entregas.");
    expect(r.dados?.destaques[0]).toEqual({ rotulo: "Líder", valor: "Ana Souza" });
  });

  it("recusa SQL de escrita mesmo que a IA tente", async () => {
    const ia = new IaFalsa((p) => {
      if (p.sistema.includes("assistente de voz")) return { intencao: "dados" };
      if (p.sistema.includes("planeja como responder")) return { ferramenta: "sql", parametros: {}, tabelas: ["bi_entregas"] };
      if (p.sistema.includes("escreve UMA consulta SQL")) return { sql: "DELETE FROM bi_entregas", explicacao: "x" };
      return {};
    });
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "apaga as entregas");
    expect(r.dados ?? null).toBeNull();
    expect(r.fala).toMatch(/Não consegui montar/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.bi_entregas");
    expect(rows[0].n).toBe(3);
  });
});
