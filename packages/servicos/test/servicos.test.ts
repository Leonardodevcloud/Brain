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
