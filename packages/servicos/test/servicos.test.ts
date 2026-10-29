import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmissorTokens } from "@cerebro/auth";
import { criarPoolLeitura, sincronizarAcesso } from "@cerebro/central";
import { esquemaCriarRegistro, esquemaPergunta, type AtaDados, type UsuarioDTO } from "@cerebro/core";
import { emails as caixaDb, integracoes, jobs, type Pool } from "@cerebro/db";
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
  configVoz,
  salvarVoz,
  gerarFala,
  prepararFala,
  lerGrafico,
  memorizar,
  sincronizarRegrasDoCodigo,
  limparCodigo,
  arquivoDeRegra,
  type FonteCodigo,
  listarConversas,
  obterConversa,
  gravarConversa,
  apagarConversa,
  guardarPlanilha,
  consultarPlanilha,
  lerAnexo,
  falaEmCurso,
  montarMapa,
  painel,
  responder,
  tarefas,
  documentos,
  agenda,
  caixaEmail,
  type Ator,
  type Contexto,
} from "../src/index.js";
import type { PedidoTexto } from "@cerebro/ia";
import { EmbeddingsFalsos, IaFalsa, URL_TESTE, bancoLimpo, contextoDeTeste } from "./apoio.js";

/** IA falsa que segue um roteiro de etapas do agente (uma função por etapa). */
const roteiro = (passos: ((p: PedidoTexto) => object)[]) =>
  new IaFalsa((p) => {
    // Conta só as etapas depois da pergunta atual (o histórico também tem respostas do assistente).
    const inicio = p.mensagens.findLastIndex((m) => m.papel === "user" && m.conteudo.startsWith("Agora são"));
    const etapa = p.mensagens.slice(inicio).filter((m) => m.papel === "assistant").length;
    return (passos[Math.min(etapa, passos.length - 1)] ?? (() => ({ acao: "responder", fala: "ok" })))(p);
  });
const ultimaMensagem = (p: PedidoTexto) => p.mensagens.at(-1)!.conteudo;

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

  it("o administrador muda nome, e-mail de login e senha; as sessões antigas caem", async () => {
    const pessoa = await acesso.criarUsuario(ctx, atorAdmin, { nome: "Leonardo Teste", email: "leo.teste@tutts.com.br", senha: "senhaForte789", papel: "admin" });
    const antigo = await acesso.entrar(ctx, emissor, { email: "leo.teste@tutts.com.br", senha: "senhaForte789" });
    await expect(acesso.editarUsuario(ctx, atorMembro, pessoa.id, { nome: "X" })).rejects.toMatchObject({ status: 403 });
    await expect(acesso.editarUsuario(ctx, atorAdmin, pessoa.id, { email: "SUP@tutts.com.br" })).rejects.toMatchObject({ status: 409 });
    await expect(acesso.editarUsuario(ctx, atorAdmin, pessoa.id, { novaSenha: "fraca" })).rejects.toMatchObject({ status: 400 });

    const r = await acesso.editarUsuario(ctx, atorAdmin, pessoa.id, { nome: "Marcos Gabriel", email: "Contato.Teste@tutts.com.br", novaSenha: "novaSenha12345" });
    expect(r.usuario).toMatchObject({ nome: "Marcos Gabriel", email: "contato.teste@tutts.com.br" });
    expect(r.sessoesEncerradas).toBe(true);
    await expect(acesso.renovarSessao(ctx, emissor, antigo.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(acesso.entrar(ctx, emissor, { email: "leo.teste@tutts.com.br", senha: "novaSenha12345" })).rejects.toMatchObject({ status: 401 });
    const novo = await acesso.entrar(ctx, emissor, { email: "contato.teste@tutts.com.br", senha: "novaSenha12345" });
    expect(novo.usuario.nome).toBe("Marcos Gabriel");

    // Só o nome: sessão continua.
    expect((await acesso.editarUsuario(ctx, atorAdmin, pessoa.id, { nome: "Marcos G." })).sessoesEncerradas).toBe(false);
  });

  it("não deixa o Cérebro sem administrador", async () => {
    const lista = await acesso.listarUsuarios(ctx);
    const admins = lista.filter((u) => u.papel === "admin" && u.ativo);
    // Rebaixa todos menos um; o último não pode cair.
    for (const a of admins.slice(1)) await acesso.editarUsuario(ctx, atorAdmin, a.id, { papel: "membro" });
    await expect(acesso.editarUsuario(ctx, atorAdmin, admins[0]!.id, { papel: "membro" })).rejects.toMatchObject({ status: 400 });
    await expect(acesso.editarUsuario(ctx, atorAdmin, admins[0]!.id, { ativo: false })).rejects.toMatchObject({ status: 400 });
    for (const a of admins.slice(1)) await acesso.editarUsuario(ctx, atorAdmin, a.id, { papel: "admin" });
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
    await pool.query(`UPDATE cerebro.registros SET revisar_em = current_date - 2 WHERE id = $1`, [popId]);
    const afetados = await conhecimento.marcarVencidos(ctx);
    expect(afetados.map((a) => a.id)).toContain(popId);
    const r = await conhecimento.confirmarRevisao(ctx, atorMembro, popId);
    expect(r.status).toBe("vigente");
  });

  it("confirmar antes do vencimento empurra a data a partir do vencimento atual", async () => {
    await pool.query(`UPDATE cerebro.registros SET revisar_em = '2099-01-10', status = 'vigente' WHERE id = $1`, [popId]);
    const r = await conhecimento.confirmarRevisao(ctx, atorMembro, popId);
    expect(r.revisarEm).toBe("2099-04-10"); // POP: 90 dias depois do vencimento, não de hoje
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

    await conhecimento.aprovarRegistro(ctx, atorAdmin, ataId, { decisoes: [0], pendencias: [0] });
    const aprovada = await conhecimento.obterRegistro(ctx, ataId);
    expect(aprovada.status).toBe("vigente");
    const decisao = aprovada.relacoes.find((r) => r.sentido === "entrada");
    expect(decisao?.registro).toMatchObject({ status: "vigente" });
    expect(decisao?.registro.codigo).toMatch(/^DEC-/);

    // A pendência marcada virou tarefa do Cérebro, ligada à ata, com o prazo da ata.
    const daAta = await tarefas.listarTarefas(ctx, atorAdmin, { registroId: ataId });
    expect(daAta.map((t) => t.titulo)).toEqual(["Atualizar o POP de troca em rota"]);
    expect(daAta[0]).toMatchObject({ origem: "ata", prazo: "2026-10-28", responsavel: { id: null, nome: "Supervisão SSA" } });
    expect(daAta[0]!.registros[0]).toMatchObject({ id: ataId, origem: true });
  });
});

describe("tarefas", () => {
  it("cria, reconhece o responsável pelo nome, move no quadro e conclui", async () => {
    const a = await tarefas.criarTarefa(ctx, atorAdmin, { titulo: "Ligar para a Rede Beta", responsavelTexto: "admin", prazo: "2020-01-01" });
    expect(a.codigo).toMatch(/^TAR-\d{3}$/);
    expect(a.responsavel).toMatchObject({ id: admin.id, nome: "Admin" });
    expect(a.atrasada).toBe(true);
    const b = await tarefas.criarTarefa(ctx, atorMembro, { titulo: "Revisar escala de sábado", responsavelTexto: "Supervisão Maceió" });
    expect(b.responsavel).toEqual({ id: null, nome: "Supervisão Maceió" });

    // Arrasta B para antes de A na mesma coluna, depois A para "fazendo".
    await tarefas.moverTarefa(ctx, atorAdmin, b.id, { status: "a_fazer", antesDe: a.id });
    const coluna = (await tarefas.listarTarefas(ctx, atorAdmin)).filter((t) => t.status === "a_fazer").map((t) => t.id);
    expect(coluna.indexOf(b.id)).toBeLessThan(coluna.indexOf(a.id));
    await tarefas.moverTarefa(ctx, atorAdmin, a.codigo, { status: "feita", antesDe: null });
    const feita = await tarefas.obterTarefa(ctx, a.id);
    expect(feita).toMatchObject({ status: "feita", atrasada: false });
    expect(feita.concluidaEm).not.toBeNull();
    expect(feita.historico.map((h) => h.acao)).toContain("concluiu");

    expect((await tarefas.listarTarefas(ctx, atorAdmin, { filtro: "minhas" })).every((t) => t.responsavel?.id === admin.id)).toBe(true);
    expect((await tarefas.listarTarefas(ctx, atorAdmin, { filtro: "atrasadas" })).some((t) => t.id === a.id)).toBe(false);
  });

  it("só quem criou ou o administrador exclui", async () => {
    const t = await tarefas.criarTarefa(ctx, atorAdmin, { titulo: "Tarefa do admin" });
    await expect(tarefas.excluirTarefa(ctx, atorMembro, t.id)).rejects.toMatchObject({ status: 403 });
    await tarefas.excluirTarefa(ctx, atorAdmin, t.id);
    await expect(tarefas.obterTarefa(ctx, t.id)).rejects.toMatchObject({ status: 404 });
  });

  it("sem a agenda com escrita, explica que precisa reconectar", async () => {
    const t = await tarefas.criarTarefa(ctx, atorAdmin, { titulo: "Lembrete" });
    await expect(tarefas.criarLembrete(ctx, atorAdmin, t.id)).rejects.toMatchObject({ status: 503 });
  });
});

describe("agenda e e-mail", () => {
  it("sem Google, a agenda mostra os prazos das tarefas da semana", async () => {
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia" }).format(new Date());
    const t = await tarefas.criarTarefa(ctx, atorAdmin, { titulo: "Prazo de hoje na agenda", prazo: hoje });
    const a = await agenda.listarAgenda(ctx, atorAdmin, hoje, 7);
    expect(a.google).toBe("desligada");
    expect(a.itens.some((i) => i.tipo === "tarefa" && i.tarefa?.codigo === t.codigo)).toBe(true);
    await expect(agenda.criarLembrete(ctx, atorAdmin, { titulo: "Conferir saques", quando: `${hoje}T18:00` })).rejects.toMatchObject({ status: 503 });
    await expect(agenda.criarLembrete(ctx, atorAdmin, { titulo: "x", quando: hoje })).rejects.toMatchObject({ status: 400 });
  });

  it("guarda o e-mail, mostra como pendente e vira tarefa, registro ou ignorado", async () => {
    await caixaDb.guardar(pool, { chave: "email:teste-1", remetente: "Tatiana <t@rede.com>", assunto: "Falta de motoboy pela manhã", recebidoEm: new Date(), texto: "Hoje a loja ficou sem motoboy das 8h às 10h." });
    await caixaDb.guardar(pool, { chave: "email:teste-1", remetente: "dup", assunto: "dup", recebidoEm: null, texto: "dup" });
    await caixaDb.guardar(pool, { chave: "email:teste-2", remetente: "noreply@x.com", assunto: "Fatura", recebidoEm: new Date(), texto: "Sua fatura chegou." });

    let caixa = await caixaEmail.listarEmails(ctx, "pendentes");
    expect(caixa.emails.filter((e) => e.assunto === "Falta de motoboy pela manhã")).toHaveLength(1);
    expect(caixa.pendentes).toBeGreaterThanOrEqual(2);
    const falta = caixa.emails.find((e) => e.assunto.startsWith("Falta"))!;
    const fatura = caixa.emails.find((e) => e.assunto === "Fatura")!;

    const comTarefa = await caixaEmail.emailParaTarefa(ctx, atorMembro, falta.id);
    expect(comTarefa.situacao).toBe("tarefa");
    expect(comTarefa.tarefa?.codigo).toMatch(/^TAR-/);
    const t = await tarefas.obterTarefa(ctx, comTarefa.tarefa!.codigo);
    expect(t.origem).toBe("email");
    expect(t.descricao).toContain("Tatiana");

    const ignorado = await caixaEmail.ignorarEmail(ctx, atorMembro, fatura.id);
    expect(ignorado.situacao).toBe("ignorado");
    expect(ignorado.pendente).toBe(false);
    expect((await caixaEmail.listarEmails(ctx, "ignorados")).emails.some((e) => e.id === fatura.id)).toBe(true);
    const devolvido = await caixaEmail.ignorarEmail(ctx, atorMembro, fatura.id, true);
    expect(devolvido.pendente).toBe(true);

    const comRegistro = await caixaEmail.emailParaRegistro(ctx, atorMembro, fatura.id);
    expect(comRegistro.situacao).toBe("registro");
    expect(comRegistro.registro?.status).toBe("rascunho");
    caixa = await caixaEmail.listarEmails(ctx, "registro");
    expect(caixa.emails.some((e) => e.id === fatura.id)).toBe(true);

    await expect(caixaEmail.ignorarEmail(ctx, ATOR_SISTEMA, fatura.id)).rejects.toMatchObject({ status: 403 });
    await expect(caixaEmail.emailParaTarefa(ctx, atorAdmin, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ status: 404 });
  });
});

// PDF mínimo com uma linha de texto (gerado à mão: offsets do xref corretos).
function pdfComTexto(texto: string) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const fluxo = `BT /F1 18 Tf 72 720 Td (${texto}) Tj ET`;
  objs[3] = `<< /Length ${fluxo.length} >>\nstream\n${fluxo}\nendstream`;
  let corpo = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(corpo.length);
    corpo += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = corpo.length;
  corpo += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  corpo += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(corpo);
}

describe("documentos", () => {
  it("lê Word, PDF e planilha, vira conhecimento buscável e não aceita o mesmo arquivo duas vezes", async () => {
    const docx = zipSync({
      "word/document.xml": strToU8(
        '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Manual do motoboy</w:t></w:r></w:p>' +
          "<w:p><w:r><w:t>Use sempre o colete e confira a nota antes de sair da loja.</w:t></w:r></w:p></w:body></w:document>",
      ),
    });
    const reg = await documentos.enviarDocumento(ctx, atorAdmin, { nome: "Manual_do_motoboy.docx", bytes: docx, area: "pessoas" });
    expect(reg).toMatchObject({ tipo: "documento", status: "vigente", titulo: "Manual do motoboy", area: "pessoas" });
    expect(reg.codigo).toMatch(/^DOC-/);
    expect(reg.conteudo).toContain("## Manual do motoboy");
    expect(reg.conteudo).toContain("confira a nota");
    await expect(documentos.enviarDocumento(ctx, atorAdmin, { nome: "copia.docx", bytes: docx })).rejects.toMatchObject({ status: 409 });

    const pdf = await documentos.enviarDocumento(ctx, atorMembro, { nome: "contrato-rede-beta.pdf", bytes: pdfComTexto("Prazo de coleta ate 17h para a Rede Beta") });
    expect(pdf.status).toBe("rascunho"); // quem não é admin envia para aprovação
    expect(pdf.conteudo).toContain("Prazo de coleta ate 17h");

    const xlsx = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Tabela km" sheetId="1"/></sheets></workbook>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Faixa</t></si><si><t>Valor</t></si><si><t>0 a 5 km</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c></row></sheetData></worksheet>',
      ),
    });
    const planilha = await documentos.enviarDocumento(ctx, atorAdmin, { nome: "tabela.xlsx", bytes: xlsx });
    expect(planilha.conteudo).toBe("## Tabela km\n\nFaixa | Valor\n0 a 5 km | 12.5");

    const arquivo = await documentos.baixarArquivo(ctx, reg.codigo);
    expect(arquivo).toMatchObject({ nome: "Manual_do_motoboy.docx" });
    expect(new Uint8Array(arquivo.conteudo)).toEqual(docx);
    await expect(documentos.enviarDocumento(ctx, atorAdmin, { nome: "virus.exe", bytes: strToU8("MZ") })).rejects.toMatchObject({ status: 400 });
  });

  it("só o administrador exclui, e precisa repetir o código", async () => {
    const r = await documentos.enviarDocumento(ctx, atorAdmin, { nome: "nota-solta.txt", bytes: strToU8("Texto de um documento que vai ser excluído depois.") });
    await expect(conhecimento.excluirRegistro(ctx, atorMembro, r.id, r.codigo)).rejects.toMatchObject({ status: 403 });
    await expect(conhecimento.excluirRegistro(ctx, atorAdmin, r.id, "DOC-999")).rejects.toMatchObject({ status: 400 });
    await conhecimento.excluirRegistro(ctx, atorAdmin, r.id, r.codigo.toLowerCase());
    await expect(conhecimento.obterRegistro(ctx, r.id)).rejects.toMatchObject({ status: 404 });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM cerebro.arquivos WHERE registro_id = $1", [r.id]);
    expect(rows[0].n).toBe(0);
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

  it("entende comandos óbvios sem precisar da IA", async () => {
    const semIa = { ...ctx, ia: null };
    const r = await atenderFala(semIa, atorMembro, "Argos, abre o mapa");
    expect(r).toMatchObject({ intencao: "navegar", acao: { destino: "/mapa", automatica: true } });
    expect(interpretarRapido("o que tem para revisar hoje?")?.intencao).toBe("pendencias");
    const p = await atenderFala(semIa, atorMembro, "o que eu tenho pra aprovar?");
    expect(p.intencao).toBe("pendencias");
    expect(p.fala).toMatch(/aprovar|em dia/);
  });

  it("agente: procura no Cérebro e responde com as fontes", async () => {
    const ia = roteiro([
      () => ({ acao: "conhecimento", busca: "falta de motoboy manhã" }),
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Encontrado no Cérebro/);
        return { acao: "responder", fala: "Realoque o motoboy da janela seguinte e avise a loja.", analise: null };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia }, atorMembro, "como tratamos falta de motoboy pela manhã?");
    expect(r.intencao).toBe("perguntar");
    expect(r.fala).toBe("Realoque o motoboy da janela seguinte e avise a loja.");
    expect(r.fontes.length).toBeGreaterThan(0);
    expect(r.acao?.destino).toMatch(/^\/registros\//);
  });

  it("agente: conversa pelo nome e lembra da troca anterior", async () => {
    const ia = roteiro([
      (p) => {
        expect(p.sistema).toContain("Você está falando com: Admin");
        expect(p.mensagens.length).toBe(3); // pergunta anterior, resposta anterior, pergunta nova
        return { acao: "responder", fala: "Tudo ótimo, Admin! Em que posso ajudar?" };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "oi, tudo bem?", [{ pergunta: "como está a disponibilidade?", resposta: "24 em loja de 41." }]);
    expect(r).toMatchObject({ intencao: "conversa", fala: "Tudo ótimo, Admin! Em que posso ajudar?" });
  });

  it("agente: salva o que foi ditado sempre como rascunho", async () => {
    const ia = roteiro([
      () => ({ acao: "rascunho", tipo: "decisao", titulo: "Coleta só até 17h", conteudo: "A partir de novembro, coletas só até 17h." }),
      () => ({ acao: "responder", fala: "Anotei como rascunho de decisão." }),
    ]);
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "salva como decisão: a partir de novembro coleta só até 17h");
    expect(r.intencao).toBe("rascunho");
    const id = r.acao!.destino.split("/").pop()!;
    const reg = await conhecimento.obterRegistro(ctx, id);
    expect(reg).toMatchObject({ tipo: "decisao", status: "rascunho", titulo: "Coleta só até 17h" });
    expect(reg.dados).toMatchObject({ via: "voz" });
  });

  it("agente: cria tarefa quando pedem e abre a tela de tarefas", async () => {
    const ia = roteiro([
      () => ({ acao: "criar_tarefa", titulo: "Revisar a escala de sábado", responsavel: "Supervisão Maceió", prazo: "2026-10-31" }),
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Tarefa TAR-\d+ criada para Supervisão Maceió/);
        return { acao: "responder", fala: "Criei a tarefa para a Supervisão de Maceió, com prazo sábado." };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "cria uma tarefa pra supervisão de maceió revisar a escala de sábado");
    expect(r.acao?.destino).toMatch(/^\/tarefas\?abrir=TAR-\d+$/);
    expect(interpretarRapido("abre as tarefas")).toMatchObject({ intencao: "navegar", alvo: "tarefas" });
  });

  it("agente: o histórico da conversa vai como contexto, com os nomes mascarados", async () => {
    let visto = "";
    const ia = roteiro([
      (p) => {
        visto = p.mensagens.map((m) => m.conteudo).join("\n");
        return { acao: "responder", fala: "O pior foi o [PESSOA_1]." };
      },
    ]);
    const historico = [
      { pergunta: "produção por motoboy hoje em Brasília", resposta: "Antônio Carlos Jansem teve 4 entregas fora do prazo.\n[Tabela mostrada: Produção por motoboy]\nNome prof | Entregas\nAntônio Carlos Jansem | 5\nAilton Silva dos Santos | 6" },
    ];
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "e quem foi o pior?", historico);
    expect(visto).toContain("Tabela mostrada");
    expect(visto).not.toContain("Antônio Carlos Jansem");
    expect(visto).not.toContain("Ailton Silva dos Santos");
    expect(r.fala).not.toContain("[PESSOA_");
    expect(r.fala).toMatch(/Antônio Carlos Jansem|Ailton Silva dos Santos/);
  });

  it("agente: não duplica tarefa no mesmo pedido", async () => {
    const ia = roteiro([
      () => ({ acao: "criar_tarefa", titulo: "Ligar para a Rede Gama" }),
      () => ({ acao: "criar_tarefa", titulo: "Ligar para a Rede Gama de novo" }),
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/já foi criada agora/);
        return { acao: "responder", fala: "Pronto, anotei." };
      },
    ]);
    const antes = (await tarefas.listarTarefas(ctx, atorAdmin)).length;
    await atenderFala({ ...ctx, ia }, atorAdmin, "anota pra eu ligar pra rede gama");
    expect((await tarefas.listarTarefas(ctx, atorAdmin)).length).toBe(antes + 1);
  });

  it("agente: reunião vai para a agenda (e explica quando o Google não está ligado)", async () => {
    const ia = roteiro([
      (p) => {
        expect(p.sistema).toContain("agendar_reuniao");
        return { acao: "agendar_reuniao", titulo: "Reunião com o Grupo Comollati", inicio: "2026-10-27T14:00", convidados: ["Leonardo"], meet: true };
      },
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Não consegui marcar: .*Google Agenda/);
        return { acao: "responder", fala: "O Google Agenda não está conectado, então não consegui marcar." };
      },
    ]);
    const antes = (await tarefas.listarTarefas(ctx, atorAdmin)).length;
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "marca uma reunião amanhã às 14h com o grupo comollati");
    expect(r.fala).toMatch(/Google Agenda/);
    expect((await tarefas.listarTarefas(ctx, atorAdmin)).length).toBe(antes);
    await expect(agenda.criarReuniao(ctx, atorAdmin, { titulo: "Sem hora", inicio: "2026-10-27" })).rejects.toMatchObject({ status: 400 });
  });

  it("desconectar a agenda apaga o acesso guardado (só o admin)", async () => {
    await integracoes.salvar(pool, "google", { config: { conectadoEm: new Date().toISOString(), conta: "x@gmail.com" }, segredo: "cifrado" });
    await expect(painel.desconectarGoogle(ctx, atorMembro)).rejects.toMatchObject({ status: 403 });
    await painel.desconectarGoogle(ctx, atorAdmin);
    const salvo = await integracoes.obter(pool, "google");
    expect(salvo?.segredo).toBeNull();
    expect(salvo?.config.desconectadoEm).toBeTruthy();
  });

  it("agente: na dúvida, pergunta de volta e a tela fica esperando a resposta", async () => {
    const ia = roteiro([() => ({ acao: "responder", fala: "Não achei a loja Faro. Era a loja Farol?", confirmar: true, analise: "x", mostrar: "r1" })]);
    const r = await atenderFala({ ...ctx, ia }, atorAdmin, "como está a loja do faro [áudio pouco claro]");
    expect(r.aguardaResposta).toBe(true);
    expect(r.dados ?? null).toBeNull();
    expect(r.detalhe).toBeNull();
  });

  it("agente: abre um registro pelo código", async () => {
    const ia = roteiro([() => ({ acao: "responder", fala: "Abrindo o POP 1.", abrir: "POP-001" })]);
    const r = await atenderFala({ ...ctx, ia }, atorMembro, "abre o pop 1");
    expect(r.acao?.destino).toBe("/registros/POP-001");
  });

  it("se a IA falhar, cai nas regras simples", async () => {
    const quebrada = new IaFalsa(() => {
      throw new Error("fora do ar");
    });
    const r = await atenderFala({ ...ctx, ia: quebrada }, atorAdmin, "valeu");
    expect(r.fala).toMatch(/^Por nada/);
  });

  it("voz do servidor: a escolha vale para todos e frases repetidas saem do cache", async () => {
    let chamadas = 0;
    const fala = { nome: "falsa", falar: async (_t: string, o: { voz: string }) => (chamadas++, new TextEncoder().encode(o.voz)) };
    const c = { ...ctx, fala };
    expect(await configVoz({ ...ctx, fala: null })).toMatchObject({ disponivel: false, voz: "marin" });
    await salvarVoz(c, atorAdmin, { voz: "cedar", velocidade: 1.2 });
    expect(await configVoz(c)).toMatchObject({ disponivel: true, voz: "cedar", velocidade: 1.2 });
    expect(new TextDecoder().decode(await gerarFala(c, "Bom dia"))).toBe("cedar");
    await gerarFala(c, "Bom dia");
    expect(chamadas).toBe(1);
    await expect(salvarVoz(c, atorAdmin, { voz: "robo", velocidade: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(gerarFala({ ...ctx, fala: null }, "oi")).rejects.toMatchObject({ status: 503 });
  });

  it("voz em fluxo: começa a gerar na hora, entrega os pedaços e guarda no cache", async () => {
    let chamadas = 0;
    const fala = {
      nome: "falsa",
      falar: async () => (chamadas++, new Uint8Array([9])),
      falarFluxo: async () =>
        (async function* () {
          chamadas++;
          yield new Uint8Array([1, 2]);
          yield new Uint8Array([3]);
        })(),
    };
    const c = { ...ctx, fala };
    const id = await prepararFala(c, "Oi, tudo certo por aqui.");
    await new Promise((r) => setTimeout(r, 20));
    const f = falaEmCurso(id)!;
    expect(f.terminou).toBe(true);
    expect(f.pedacos.map((p) => [...p])).toEqual([[1, 2], [3]]);
    expect([...(await gerarFala(c, "Oi, tudo certo por aqui."))]).toEqual([1, 2, 3]);
    expect(chamadas).toBe(1);
    expect(falaEmCurso("00000000-0000-4000-8000-000000000000")).toBeNull();
    // Com "falar", a resposta já vem com o 1º trecho sendo gerado.
    const r = await atenderFala({ ...c, ia: null }, atorAdmin, "obrigado, Argos", [], { falar: true });
    expect(r.voz?.texto).toBe(r.fala); // frase curta: um trecho só
    expect(falaEmCurso(r.voz!.id)).not.toBeNull();
  });

  it("gráfico: confere colunas e números, e só abre primeiro quando a pessoa pede", () => {
    const r = { colunas: ["dia", "faturamento", "regiao"], linhas: [{ dia: "2026-10-01", faturamento: "120.5", regiao: "Salvador" }, { dia: "2026-10-02", faturamento: 98, regiao: "Natal" }] };
    expect(lerGrafico({ tipo: "linha", x: "dia", y: ["faturamento", "regiao", "nao_existe"] }, r, "faturamento em gráfico")).toEqual({
      tipo: "linha", x: "dia", y: ["faturamento"], titulo: null, principal: true,
    });
    expect(lerGrafico({ tipo: "barras", x: "regiao", y: "faturamento", titulo: "Por região" }, r, "como foi o faturamento?")).toMatchObject({ y: ["faturamento"], principal: false, titulo: "Por região" });
    expect(lerGrafico({ tipo: "linha", x: "dia", y: ["regiao"] }, r, "x")).toBeNull(); // texto não vira eixo de valores
    expect(lerGrafico({ tipo: "radar", x: "dia", y: ["faturamento"] }, r, "x")).toBeNull();
    expect(lerGrafico({ tipo: "linha", x: "inventada", y: ["faturamento"] }, r, "x")).toBeNull();
    expect(lerGrafico(null, r, "x")).toBeNull();
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
        dentro_prazo boolean, valor numeric, valor_prof numeric, cod_cliente int, cod_prof int, centro_custo varchar, ocorrencia varchar, os_concluida boolean DEFAULT true,
        finalizado timestamp DEFAULT now(), data_hora timestamp, tempo_execucao_minutos int, dentro_prazo_prof boolean, tempo_entrega_prof_minutos int);
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

  it("agente rápido: já traz a consulta pronta prevista e responde numa etapa só, sem raciocínio longo", async () => {
    const ia = roteiro([
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Resultado r1 — /);
        expect(ultimaMensagem(p)).not.toContain("Ana Souza");
        return { acao: "responder", fala: "Agora são 2 motoboys em loja de 4.", destaques: [], mostrar: "r1" };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "como está a disponibilidade agora?");
    expect(ia.pedidos).toHaveLength(1);
    expect(ia.pedidos[0]!.raciocinio).toBe("desligado");
    expect(r.dados?.origem).toBe("pronta");
    expect(r.dados?.totais).toMatchObject({ titulares: 4, em_loja: 2 });
    expect(r.tempos).toMatchObject({ total: expect.any(Number), ia1: expect.any(Number) });
  });

  it("agente: olha as colunas, escreve o SQL, corrige o erro e analisa sem ver nomes", async () => {
    const ia = roteiro([
      (p) => {
        expect(p.sistema).toContain("bi_entregas");
        return { acao: "colunas", tabelas: ["bi_entregas", "tabela_que_nao_existe"] };
      },
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/nome_prof/);
        expect(ultimaMensagem(p)).toMatch(/Não existem: tabela_que_nao_existe/);
        return { acao: "sql", sql: "SELECT nome_errado FROM bi_entregas", titulo: "erro proposital" };
      },
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Erro na consulta/);
        return {
          acao: "sql",
          sql: "SELECT nome_prof AS motoboy, COUNT(*) AS entregas FROM bi_entregas WHERE COALESCE(ponto,1) >= 2 GROUP BY 1 ORDER BY 2 DESC",
          titulo: "Entregas por motoboy hoje",
        };
      },
      (p) => {
        const visto = ultimaMensagem(p);
        expect(visto).not.toContain("Ana Souza"); // nomes de pessoas vão mascarados
        const marcador = /\[PESSOA_\d+\]/.exec(visto)?.[0] ?? "?";
        return { acao: "responder", fala: `${marcador} lidera com 2 entregas.`, analise: "- Ritmo bom.", destaques: [{ rotulo: "Líder", valor: marcador }], mostrar: "r1" };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "quem mais entregou hoje?");
    expect(r.intencao).toBe("dados");
    expect(r.dados).toMatchObject({ origem: "livre", tabelas: ["bi_entregas"], titulo: "Entregas por motoboy hoje" });
    expect(r.dados?.linhas[0]).toMatchObject({ motoboy: "Ana Souza" });
    expect(r.fala).toBe("Ana Souza lidera com 2 entregas.");
    expect(r.dados?.destaques[0]).toEqual({ rotulo: "Líder", valor: "Ana Souza" });
    expect(r.dados?.analise).toBe("- Ritmo bom.");
  });

  it("agente: usa a consulta pronta e entende a continuação da conversa", async () => {
    const ia = roteiro([
      (p) => {
        expect(p.mensagens[0]!.conteudo).toContain("como está a disponibilidade?");
        return { acao: "pronta", nome: "disponibilidade", parametros: { regiao: "salvador", por: "loja" } };
      },
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/"titulares":4/);
        return { acao: "responder", fala: "Em Salvador são 2 em loja de 4.", destaques: [{ rotulo: "Em loja", valor: "2 de 4" }] };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "e em Salvador?", [
      { pergunta: "como está a disponibilidade?", resposta: "Agora são 2 em loja de 4." },
    ]);
    expect(r).toMatchObject({ intencao: "dados", fala: "Em Salvador são 2 em loja de 4." });
    expect(r.dados?.origem).toBe("pronta");
  });

  it("recusa SQL de escrita mesmo que a IA tente", async () => {
    const ia = roteiro([
      () => ({ acao: "sql", sql: "DELETE FROM bi_entregas" }),
      (p) => {
        expect(ultimaMensagem(p)).toMatch(/Erro na consulta/);
        return { acao: "responder", fala: "Eu só consigo ler os dados, não apagar." };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia, central: leitura }, atorAdmin, "apaga as entregas");
    expect(r.dados ?? null).toBeNull();
    expect(r.fala).toMatch(/só consigo ler/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.bi_entregas");
    expect(rows[0].n).toBe(3);
  });
});


describe("memória do Argos", () => {
  it("toda resposta leva a memória junto (até rascunho recém-guardado) e diz quais usou", async () => {
    const nota = await conhecimento.criarRegistro(
      ctx,
      atorAdmin,
      novo({ tipo: "nota", titulo: "Margem por motoboy na BR AutoParts", conteudo: "Margem = R$ 250 menos o valor pago ao motoboy menos R$ 80 de diária. O valor cobrado do cliente não entra." }),
      { origem: "manual", sempreRascunho: true },
    );
    await rodarIndexacao();
    let vista = "";
    const iaRot = roteiro([
      (p) => {
        vista = ultimaMensagem(p);
        return { acao: "responder", fala: "Pela regra que você me passou, a margem é 250 menos o pago menos 80.", usou: [nota.codigo, "XYZ-999"] };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia: iaRot }, atorAdmin, "como eu calculo a margem por motoboy da BR AutoParts?");
    expect(vista).toContain("Memória do Cérebro");
    expect(vista).toContain(`[${nota.codigo}] [não revisada]`);
    expect(r.memorias).toEqual([{ registroId: nota.id, codigo: nota.codigo, titulo: nota.titulo, naoRevisada: true }]);
  });

  it("guarda sozinho o que a pessoa ensinou, atualiza em vez de duplicar e recusa dado pessoal", async () => {
    let chamada = 0;
    let primeira = "";
    const iaMem = new IaFalsa((p) => {
      if (!p.sistema.includes("memória de longo prazo")) return { resposta: "x" };
      chamada++;
      if (chamada === 1) {
        primeira = p.mensagens[0]!.conteudo;
        return { memorias: [{ titulo: "Pellegrino é o grupo Comollati", conteudo: "Quando falarem Pellegrino, é o grupo Comollati (código 767). SLA de 120 minutos.", area: "comercial" }, { titulo: "PIX do Fulano", conteudo: "Chave pix 123.456.789-09" }] };
      }
      return { memorias: [{ titulo: "Pellegrino é o grupo Comollati", conteudo: "Pellegrino = Comollati (767). SLA de 90 minutos a partir de novembro.", atualiza: codigo }] };
    });
    let codigo = "";
    const c = { ...ctx, ia: iaMem };
    const g1 = await memorizar(c, atorAdmin, { pergunta: "anota aí: Pellegrino é o grupo Comollati, código 767, e o SLA deles é 120 minutos", resposta: "Entendido." });
    expect(g1).toHaveLength(1); // o PIX foi recusado
    expect(g1[0]).toMatchObject({ titulo: "Pellegrino é o grupo Comollati", acao: "nova" });
    codigo = g1[0]!.codigo;
    const salvo = await conhecimento.obterRegistro(ctx, g1[0]!.registroId);
    expect(salvo.status).toBe("rascunho");
    // Já encontrável pela busca, sem esperar o worker.
    const achados = await responder(ctx, atorAdmin, esquemaPergunta.parse({ pergunta: "quem é o Pellegrino?", incluirRascunhos: true }));
    expect(achados.fontes.map((f) => f.codigo)).toContain(codigo);
    const g2 = await memorizar(c, atorAdmin, { pergunta: "corrigindo: o SLA do Pellegrino passa a ser 90 minutos em novembro", resposta: "Ok." });
    expect(g2).toEqual([expect.objectContaining({ codigo, acao: "atualizada" })]);
    expect((await conhecimento.obterRegistro(ctx, g2[0]!.registroId)).conteudo).toContain("90 minutos");
    expect(primeira).toContain("Última troca");
    // Cumprimento nem chama a IA.
    const antes = chamada;
    expect(await memorizar(c, atorAdmin, { pergunta: "bom dia, tudo bem?", resposta: "Bom dia!" })).toEqual([]);
    expect(chamada).toBe(antes);
  });

  it("planilha: tira colunas sensíveis, entende CSV brasileiro e calcula agrupando", () => {
    const csv = "Motoboy;CPF;Loja;Valor pago;Data\nAna Souza;111.222.333-44;Centro;1.250,50;2026-10-01\nBeto Lima;222.333.444-55;Centro;300;2026-10-02\nAna Souza;111.222.333-44;Farol;100,00;2026-10-03\n";
    const a = guardarPlanilha(atorAdmin, "pagamentos.csv", new TextEncoder().encode(csv));
    expect(a.colunasOcultas).toEqual(["CPF"]);
    expect(a.abas[0]).toMatchObject({ colunas: ["Motoboy", "Loja", "Valor pago", "Data"], linhas: 3 });
    expect(lerAnexo(atorMembro, a.id)).toBeNull(); // só quem enviou
    const anexo = lerAnexo(atorAdmin, a.id)!;
    const x = consultarPlanilha(anexo, { agrupar: ["motoboy"], metricas: [{ fn: "soma", coluna: "valor pago", nome: "total" }, { fn: "contagem" }], ordenar: { coluna: "total", desc: true } });
    expect(x.linhas).toEqual([
      { Motoboy: "Ana Souza", total: 1350.5, contagem: 2 },
      { Motoboy: "Beto Lima", total: 300, contagem: 1 },
    ]);
    expect(consultarPlanilha(anexo, { filtros: [{ coluna: "Data", op: ">=", valor: "2026-10-02" }] }).total).toBe(2);
    expect(() => consultarPlanilha(anexo, { agrupar: ["Inventada"] })).toThrow(/não existe/);
  });

  it("planilha no agente: os números vêm do cálculo, e os nomes vão mascarados", async () => {
    const xlsx = zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Outubro" sheetId="1"/></sheets></workbook>'),
      "xl/sharedStrings.xml": strToU8("<sst><si><t>Motoboy</t></si><si><t>Entregas</t></si><si><t>Carla Dias Neves</t></si><si><t>Davi Rocha Leal</t></si></sst>"),
      "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>30</v></c></row></sheetData></worksheet>'),
    });
    const a = guardarPlanilha(atorAdmin, "outubro.xlsx", xlsx);
    let contexto = "";
    const iaRot = roteiro([
      (p) => {
        contexto = ultimaMensagem(p);
        return { acao: "planilha", metricas: [{ fn: "soma", coluna: "Entregas", nome: "total" }], titulo: "Total de entregas" };
      },
      (p) => {
        expect(ultimaMensagem(p)).toContain('"total":42');
        return { acao: "responder", fala: "Foram 42 entregas em outubro.", mostrar: "r1", usou: [] };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia: iaRot }, atorAdmin, "quantas entregas tem nessa planilha?", [], { anexo: a.id });
    expect(contexto).toContain('Planilha anexada "outubro.xlsx"');
    expect(contexto).not.toContain("Carla Dias Neves");
    expect(r.dados).toMatchObject({ origem: "planilha", titulo: "Total de entregas", linhas: [{ total: 42 }] });
  });
});

describe("conversas do Argos", () => {
  it("cada pessoa grava, lista, busca e apaga só as suas", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const turno = { pergunta: "Como está a disponibilidade em Salvador agora?", resposta: { texto: "x", intencao: "dados", fala: "São 35 vagas titulares.", detalhe: null, fontes: [], acao: null }, erro: null, em: Date.now() };
    const r = await gravarConversa(ctx, atorAdmin, id, [turno as never, { pergunta: "sem resposta", resposta: null, erro: null, em: 1 } as never]);
    expect(r).toMatchObject({ id, titulo: "Como está a disponibilidade em Salvador agora?", trocas: 1 });
    expect((await listarConversas(ctx, atorAdmin, "35 vagas")).map((c) => c.id)).toEqual([id]);
    expect(await listarConversas(ctx, atorAdmin, "faturamento")).toEqual([]);
    expect(await listarConversas(ctx, atorMembro)).toEqual([]);
    await expect(obterConversa(ctx, atorMembro, id)).rejects.toMatchObject({ status: 404 });
    await expect(gravarConversa(ctx, atorMembro, id, [turno as never])).rejects.toMatchObject({ status: 403 });
    expect((await obterConversa(ctx, atorAdmin, id)).turnos).toHaveLength(1);
    await apagarConversa(ctx, atorAdmin, id);
    expect(await listarConversas(ctx, atorAdmin)).toEqual([]);
  });
});

describe("Argos com as regras da Central", () => {
  it("ação central: usa a rota da tela do BI e mascara os nomes dos motoboys", async () => {
    const chamadas: { id: string; parametros: Record<string, unknown> }[] = [];
    const centralApi = {
      consultar: async (id: string, parametros: Record<string, unknown>) => {
        chamadas.push({ id, parametros });
        const { ENDPOINTS_CENTRAL } = await import("@cerebro/central");
        return {
          endpoint: ENDPOINTS_CENTRAL.find((e) => e.id === id)!,
          url: "/api/bi/dashboard-completo?data_inicio=2026-10-01&data_fim=2026-10-28",
          ms: 12,
          dados: {
            metricas: { total_entregas: 120, taxa_prazo: 91.5 },
            porCliente: [{ cod_cliente: 7, nome: "Autopeças Alfa", entregas: 80 }],
            porProfissional: [{ cod_prof: 10, nome: "Ana Souza", entregas: 50 }],
          },
        };
      },
      testar: async () => true,
    };
    let sistema = "";
    const iaRot = roteiro([
      (p) => {
        sistema = p.sistema;
        return { acao: "central", endpoint: "bi.dashboard", parametros: { data_inicio: "2026-10-01", data_fim: "2026-10-28" }, tabela: "porProfissional", titulo: "Motoboys em outubro" };
      },
      (p) => {
        const visto = ultimaMensagem(p);
        expect(visto).toContain('"metricas.taxa_prazo":91.5');
        expect(visto).toContain("porCliente (1)");
        expect(visto).not.toContain("Ana Souza");
        const marcador = /\[PESSOA_\d+\]/.exec(visto)?.[0] ?? "?";
        return { acao: "responder", fala: `Taxa de prazo de 91,5%. ${marcador} fez 50 entregas.`, mostrar: "r1" };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia: iaRot, centralApi: centralApi as never }, atorAdmin, "qual a taxa de prazo de outubro e quem mais entregou?");
    expect(sistema).toContain("bi.dashboard:");
    expect(sistema).toContain("fin.painel:");
    expect(chamadas[0]).toMatchObject({ id: "bi.dashboard" });
    expect(r.fala).toBe("Taxa de prazo de 91,5%. Ana Souza fez 50 entregas.");
    expect(r.dados).toMatchObject({ origem: "central", titulo: "Motoboys em outubro", linhas: [{ nome: "Ana Souza", entregas: 50 }] });
    expect(r.dados?.sql).toContain("GET /api/bi/dashboard-completo");
  });

  it("sem a API ligada, a IA é avisada para cair no banco", async () => {
    const iaRot = roteiro([
      () => ({ acao: "central", endpoint: "bi.dashboard", parametros: {} }),
      (p) => {
        expect(ultimaMensagem(p)).toContain("CENTRAL_API_URL");
        return { acao: "responder", fala: "A API da Central não está ligada." };
      },
    ]);
    const r = await atenderFala({ ...ctx, ia: iaRot, centralApi: null }, atorAdmin, "qual a taxa de prazo de outubro no BI?");
    expect(r.fala).toBe("A API da Central não está ligada.");
  });

  it("lê as regras do código: cria, pula o que não mudou, atualiza o que mudou e marca o que sumiu", async () => {
    const arquivos = new Map<string, { sha: string; texto: string }>([
      ["src/modules/bi/routes/dashboard.routes.js", { sha: "aaa1111", texto: `// taxa de prazo\nconst KEY = "sk_live_${"x".repeat(30)}";\n${"const x = 1;\n".repeat(40)}` }],
      ["src/modules/bi/bi.migration.js", { sha: "bbb", texto: "CREATE TABLE ...".repeat(40) }],
      ["src/modules/financial/util.js", { sha: "ccc", texto: "module.exports = {};".repeat(30) }],
    ]);
    const fonte: FonteCodigo = {
      listar: async () => [...arquivos].map(([caminho, a]) => ({ caminho, sha: a.sha, tamanho: a.texto.length })),
      ler: async (c) => arquivos.get(c)!.texto,
      urlDoArquivo: (c) => `https://github.com/x/y/blob/main/${c}`,
    };
    const enviados: string[] = [];
    let versao = 1;
    const iaRegras = new IaFalsa((p) => {
      const t = p.mensagens[0]!.conteudo;
      enviados.push(t);
      if (t.includes("util.js")) return { relevante: false };
      return {
        relevante: true,
        titulo: "Taxa de prazo no BI de entregas",
        resumo: `Como o BI calcula o prazo (v${versao}).`,
        regras: [{ nome: "Fora do prazo", descricao: "Passou do prazo do cliente, contando da criação à finalização.", formula: "fim - criação > prazo" }],
        endpoints: ["GET /api/bi/dashboard-completo → painel"],
        termos: ["SLA"],
      };
    });
    const c = { ...ctx, ia: iaRegras, iaRestrita: null };

    const r1 = await sincronizarRegrasDoCodigo(c, { fonte });
    expect(r1).toMatchObject({ arquivos: 2, lidos: 2, criados: 1, semRegras: 1, atualizados: 0, restantes: 0, erros: [] });
    expect(enviados.join("\n")).not.toContain("sk_live_");
    expect(enviados.join("\n")).not.toContain("CREATE TABLE");

    const regra = (await conhecimento.listarRegistros(c, { tipo: "sistema", pagina: 1, porPagina: 50 })).itens.find((x) => x.titulo.startsWith("Taxa de prazo"))!;
    expect(regra).toMatchObject({ tipo: "sistema", status: "vigente", titulo: "Taxa de prazo no BI de entregas (Central · BI)" });
    const completo = await conhecimento.obterRegistro(c, regra.id);
    expect(completo.conteudo).toContain("**Fora do prazo**");
    expect(completo.conteudo).toContain("src/modules/bi/routes/dashboard.routes.js");

    // Nada mudou: não chama a IA de novo.
    enviados.length = 0;
    const r2 = await sincronizarRegrasDoCodigo(c, { fonte });
    expect(r2).toMatchObject({ lidos: 0, criados: 0, atualizados: 0 });
    expect(enviados).toHaveLength(0);

    // O arquivo mudou: nova versão do mesmo registro.
    versao = 2;
    arquivos.get("src/modules/bi/routes/dashboard.routes.js")!.sha = "aaa2222";
    const r3 = await sincronizarRegrasDoCodigo(c, { fonte });
    expect(r3).toMatchObject({ lidos: 1, atualizados: 1, criados: 0 });
    const depois = await conhecimento.obterRegistro(c, regra.id);
    expect(depois.conteudo).toContain("(v2)");
    expect(depois.versoes.length).toBe(2);

    // O arquivo saiu do repositório: a regra fica obsoleta.
    arquivos.delete("src/modules/bi/routes/dashboard.routes.js");
    const r4 = await sincronizarRegrasDoCodigo(c, { fonte });
    expect(r4.obsoletos).toBe(1);
    expect((await conhecimento.obterRegistro(c, regra.id)).status).toBe("obsoleto");
    const status = (await painel.statusIntegracoes(c, atorAdmin)).find((s) => s.nome === "codigo_central")!;
    expect(status.estado).toBe("desligado"); // sem CENTRAL_GITHUB_TOKEN no ambiente de teste
  });

  it("regra vigente com cálculo pronto: o servidor usa os valores da regra, por motoboy no dia", async () => {
    await pool.query(`
      SET search_path = public;
      INSERT INTO bi_entregas (os, ponto, cod_cliente, nome_fantasia, centro_custo, cod_prof, nome_prof, data_solicitado, valor_prof) VALUES
        (910, 2, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui Prado', '2020-02-03', 30),
        (910, 3, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui Prado', '2020-02-03', 30),
        (911, 2, 767, 'Grupo Comollati', 'BR AUTO PARTS BRASILIA', 21, 'Rui Prado', '2020-02-03', 42.70),
        (912, 2, 767, 'Grupo Comollati', 'COMOLLATI BRASILIA', 22, 'Lia Matos', '2020-02-03', 180),
        (913, 2, 767, 'Grupo Comollati', 'COMOLLATI GOIANIA', 23, 'Teo Dias', '2020-02-03', 50);
      SET search_path = "$user", public;`);
    const regra = await conhecimento.criarRegistro(
      ctx,
      atorAdmin,
      novo({
        tipo: "politica",
        titulo: "Cálculo da margem de lucro por motoboy (regra validada) - COMOLLATI BRASILIA",
        conteudo: "Para cada motoboy, a margem é: lucro = 250 recebido da loja - 80 custo da moto - valor produzido pelo motoboy.",
        publicar: true,
        dados: { calculo: { nome: "margem_por_motoboy", parametros: { cod_cliente: 767, centros: ["br auto brasilia", "comollati brasilia"], receita_dia: 250, custo_dia: 80 } } },
      }),
      { origem: "manual" },
    );
    await indexarRegistro(ctx, regra.id);
    invalidarCacheBusca();
    const leitura2 = criarPoolLeitura(URL_TESTE, "senha_de_teste_do_argos_123456");
    const iaRot = roteiro([
      (p) => {
        const visto = ultimaMensagem(p);
        expect(visto).toContain("[regra vigente]");
        expect(visto).toContain("CÁLCULO PRONTO");
        // a IA erra o valor de propósito: o servidor manda o da regra
        return { acao: "pronta", nome: "margem_por_motoboy", parametros: { receita_dia: 999, custo_dia: 0, inicio: "2020-02-03" } };
      },
      (p) => {
        const visto = ultimaMensagem(p);
        expect(visto).toContain('"lucro":87.3');
        expect(visto).not.toContain("Rui Prado");
        return { acao: "responder", fala: "Margem de R$ 87,30 com 2 motoboys.", mostrar: "r1", usou: [regra.codigo] };
      },
    ]);
    try {
      const r = await atenderFala({ ...ctx, ia: iaRot, central: leitura2 }, atorAdmin, "qual a margem da Comollati Brasília em 03/02/2020?");
      expect(r.dados).toMatchObject({ origem: "pronta", totais: { motoboys_dia: 2, receita: 500, lucro: 87.3 } });
      expect(r.dados?.linhas.map((l) => l.profissional)).toEqual(["Rui Prado", "Lia Matos"]);
      expect(r.memorias?.map((m) => m.codigo)).toEqual([regra.codigo]);
    } finally {
      await leitura2.end();
    }
  });

  it("filtra migrations e testes e esconde segredos do código", () => {
    expect(arquivoDeRegra({ caminho: "src/modules/bi/bi.migration.js", sha: "x", tamanho: 9000 })).toBe(false);
    expect(arquivoDeRegra({ caminho: "src/modules/bi/x.test.js", sha: "x", tamanho: 9000 })).toBe(false);
    expect(arquivoDeRegra({ caminho: "src/modules/bi/bi.shared.js", sha: "x", tamanho: 9000 })).toBe(true);
    const limpo = limparCodigo(`const db = "postgres://u:senha@host/db"; const k = 'ghp_${"a".repeat(36)}'; // fale com joao@tutts.com.br`);
    expect(limpo).not.toMatch(/senha@host|ghp_a|joao@/);
  });
});
