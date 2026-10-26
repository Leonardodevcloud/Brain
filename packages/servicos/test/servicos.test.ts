import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmissorTokens } from "@cerebro/auth";
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
  montarMapa,
  painel,
  responder,
  type Ator,
  type Contexto,
} from "../src/index.js";
import { EmbeddingsFalsos, IaFalsa, bancoLimpo, contextoDeTeste } from "./apoio.js";

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
