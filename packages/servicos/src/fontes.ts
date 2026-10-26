import { AppError, TIPOS_REGISTRO, type AtaDados, type TipoRegistro } from "@cerebro/core";
import { emTransacao, fontesProcessadas, integracoes, registros, reunioes } from "@cerebro/db";
import {
  SISTEMA_ATA,
  SISTEMA_EXTRACAO,
  lerJson,
  mascarar,
  montarPedidoAta,
  montarPedidoExtracao,
  restaurar,
  type AtaGerada,
  type ExtracaoGerada,
} from "@cerebro/ia";
import {
  lerEmailsNovos,
  lerExportacaoClaude,
  limparCorpoEmail,
  type MapaTarefasNotion,
  type ReuniaoRecebida,
} from "@cerebro/integracoes";
import { ATOR_SISTEMA, auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";
import { fila } from "./fila.js";
import { criarRegistroEm } from "./registros.js";

const LIMITE_TRANSCRICAO = 120_000;
const LIMITE_CONVERSA = 60_000;

function exigirIa(ctx: Contexto) {
  if (!ctx.ia) throw AppError.indisponivel("A IA de análise não está configurada (IA_ANALISE_CHAVE).");
  return ctx.ia;
}

// ───────────────────────────── Reuniões → atas ─────────────────────────────

/** Guarda a reunião recebida e agenda a ata. Webhook repetido não gera ata duplicada. */
export async function registrarReuniao(ctx: Contexto, reuniao: ReuniaoRecebida, origem = "fathom") {
  return emTransacao(ctx.pool, async (db) => {
    const id = await reunioes.inserirSeNova(db, { ...reuniao, origem });
    if (!id) return { id: null, nova: false };
    await fila.gerarAta(db, id);
    await auditar(db, { ...ATOR_SISTEMA, canal: "webhook" }, "reuniao.recebida", { entidade: "reuniao", id }, { origem });
    return { id, nova: true };
  });
}

function montarConteudoAta(ata: AtaGerada, url: string | null): string {
  const lista = (itens: string[]) => (itens.length ? itens.map((i) => `- ${i}`).join("\n") : "- Nenhuma registrada.");
  const pendencias = ata.pendencias.map(
    (p) => `${p.tarefa}${p.responsavel ? ` · ${p.responsavel}` : ""}${p.prazo ? ` · até ${p.prazo}` : ""}`,
  );
  return [
    "## Resumo",
    ata.resumo,
    "## Decisões",
    lista(ata.decisoes),
    "## Pendências",
    lista(pendencias),
    ...(ata.clientes.length ? ["## Clientes citados", lista(ata.clientes)] : []),
    ...(url ? [`[Abrir a gravação](${url})`] : []),
  ].join("\n\n");
}

/** Gera a ata em rascunho a partir da transcrição, com dados pessoais mascarados. */
export async function gerarAta(ctx: Contexto, reuniaoId: string) {
  const reuniao = await reunioes.buscarPorId(ctx.pool, reuniaoId);
  if (!reuniao) throw AppError.naoEncontrado("A reunião");
  if (reuniao.ataId) return reuniao.ataId;
  const ia = exigirIa(ctx);

  const { texto, mapa } = mascarar(reuniao.transcricao.slice(0, LIMITE_TRANSCRICAO));
  const data = reuniao.inicio ? hojeLocal(reuniao.inicio) : null;
  const bruto = await ia.gerar({
    sistema: SISTEMA_ATA,
    mensagens: [{ papel: "user", conteudo: montarPedidoAta(reuniao.titulo, data, texto) }],
    json: true,
    maxTokens: 3000,
  });
  const gerada = lerJson<AtaGerada>(restaurar(bruto, mapa));
  const ata: AtaGerada = {
    titulo: gerada.titulo?.trim() || reuniao.titulo,
    resumo: gerada.resumo?.trim() || "Sem resumo.",
    decisoes: (gerada.decisoes ?? []).filter((d) => typeof d === "string" && d.trim()),
    pendencias: (gerada.pendencias ?? []).filter((p) => p?.tarefa),
    clientes: (gerada.clientes ?? []).filter((c) => typeof c === "string" && c.trim()),
  };

  const dados: AtaDados & { origemExternaId: string } = {
    origemExternaId: `${reuniao.origem}:${reuniao.externoId}`,
    reuniaoId,
    resumo: ata.resumo,
    decisoes: ata.decisoes.map((texto) => ({ texto, aprovar: true })),
    pendencias: ata.pendencias.map((p) => ({
      tarefa: p.tarefa,
      responsavel: p.responsavel ?? null,
      prazo: /^\d{4}-\d{2}-\d{2}$/.test(p.prazo ?? "") ? p.prazo : null,
      criarNoNotion: true,
    })),
    clientes: ata.clientes,
  };

  return emTransacao(ctx.pool, async (db) => {
    const ataId = await criarRegistroEm(
      db,
      ctx,
      ATOR_SISTEMA,
      {
        tipo: "reuniao",
        titulo: `${ata.titulo}${data ? ` · ${data.split("-").reverse().join("/")}` : ""}`.slice(0, 200),
        conteudo: montarConteudoAta(ata, reuniao.url),
        area: "gestao",
        empresa: "todas",
        confidencialidade: "interno",
        clienteRef: ata.clientes[0] ?? null,
        fonteUrl: reuniao.url,
        dados: dados as unknown as Record<string, unknown>,
        publicar: false,
        relacoes: [],
      },
      { origem: "reuniao", sempreRascunho: true },
    );
    await reunioes.vincularAta(db, reuniaoId, ataId);
    return ataId;
  });
}

// ───────────────────────────── Tarefas no Notion ─────────────────────────────

export async function lerMapaNotion(ctx: Contexto): Promise<MapaTarefasNotion | null> {
  const salvo = await integracoes.obter(ctx.pool, "notion");
  const mapa = salvo?.config as Partial<MapaTarefasNotion> | undefined;
  return mapa?.databaseId && mapa.propTitulo ? (mapa as MapaTarefasNotion) : null;
}

/** Cria no Notion as pendências marcadas de uma ata aprovada. Seguro para repetir. */
export async function criarTarefasDaAta(ctx: Contexto, ataId: string) {
  if (!ctx.notion) throw AppError.indisponivel("O Notion não está configurado (NOTION_TOKEN).");
  const mapa = await lerMapaNotion(ctx);
  if (!mapa) throw AppError.indisponivel("Escolha o banco de tarefas do Notion na tela de Integrações.");

  const ata = await registros.buscarPorId(ctx.pool, ataId);
  if (!ata || ata.tipo !== "reuniao") throw AppError.naoEncontrado("A ata");
  const dados = ata.dados as unknown as AtaDados;
  const criadas = [...(dados.tarefasCriadas ?? [])];
  const jaCriadas = new Set(criadas.map((c) => c.tarefa));
  const origemUrl = `${ctx.ambiente.URL_WEB.replace(/\/$/, "")}/registros/${ata.id}`;

  for (const p of dados.pendencias ?? []) {
    if (!p.criarNoNotion || jaCriadas.has(p.tarefa)) continue;
    const pagina = await ctx.notion.criarTarefa(mapa, {
      titulo: p.tarefa,
      responsavel: p.responsavel,
      prazo: p.prazo,
      origemUrl,
      descricao: `Criada a partir da ata ${ata.codigo} · ${ata.titulo}.`,
    });
    criadas.push({ tarefa: p.tarefa, notionUrl: pagina.url });
    // Salva a cada tarefa: se falhar no meio, a próxima tentativa não duplica.
    await registros.atualizar(ctx.pool, ata.id, { dados: { ...dados, tarefasCriadas: criadas } });
  }
  await auditar(ctx.pool, ATOR_SISTEMA, "notion.tarefas", { entidade: "registro", id: ataId }, { total: criadas.length });
  return criadas;
}

// ───────────────────────────── Conversas do Claude e e-mails ─────────────────────────────

export interface FonteParaExtrair {
  chave: string;
  origem: "conversa" | "email";
  titulo: string;
  texto: string;
  fonteUrl: string | null;
}

/** A IA decide se há conhecimento durável; se houver, nasce um rascunho para revisão. */
export async function extrairConhecimento(ctx: Contexto, fonte: FonteParaExtrair) {
  const vistas = await fontesProcessadas.jaProcessadas(ctx.pool, [fonte.chave]);
  if (vistas.has(fonte.chave)) return { resultado: "ja_processada" as const };
  const ia = exigirIa(ctx);

  const { texto, mapa } = mascarar(fonte.texto.slice(0, LIMITE_CONVERSA));
  const bruto = await ia.gerar({
    sistema: SISTEMA_EXTRACAO,
    mensagens: [{ papel: "user", conteudo: montarPedidoExtracao(fonte.origem, fonte.titulo, texto) }],
    json: true,
    maxTokens: 2000,
  });
  const extraido = lerJson<ExtracaoGerada>(restaurar(bruto, mapa));
  if (!extraido.relevante || !extraido.titulo || !extraido.conteudo) {
    await fontesProcessadas.marcar(ctx.pool, fonte.chave, "irrelevante");
    return { resultado: "irrelevante" as const };
  }

  const tipo: TipoRegistro =
    extraido.tipo && (TIPOS_REGISTRO as readonly string[]).includes(extraido.tipo) && extraido.tipo !== "reuniao"
      ? (extraido.tipo as TipoRegistro)
      : "nota";
  const registroId = await emTransacao(ctx.pool, async (db) => {
    const id = await criarRegistroEm(
      db,
      ctx,
      ATOR_SISTEMA,
      {
        tipo,
        titulo: extraido.titulo!.slice(0, 200),
        conteudo: `${extraido.conteudo}\n\n_Origem: ${fonte.origem === "conversa" ? "conversa no Claude" : "e-mail"} · ${fonte.titulo}_`,
        area: "gestao",
        empresa: "todas",
        confidencialidade: "interno",
        fonteUrl: fonte.fonteUrl,
        dados: { origemExternaId: fonte.chave, motivo: extraido.motivo ?? null },
        publicar: false,
        relacoes: [],
      },
      { origem: fonte.origem === "conversa" ? "importacao" : "email", sempreRascunho: true },
    );
    await fontesProcessadas.marcar(db, fonte.chave, "registro", id);
    return id;
  });
  return { resultado: "registro" as const, registroId };
}

/** Recebe o .zip exportado do Claude e agenda a análise das conversas ainda não vistas. */
export async function importarExportacaoClaude(ctx: Contexto, ator: Ator, zip: Uint8Array) {
  const conversas = lerExportacaoClaude(zip);
  const chaves = conversas.map((c) => `claude:${c.id}`);
  const vistas = await fontesProcessadas.jaProcessadas(ctx.pool, chaves);
  const novas = conversas.filter((c) => !vistas.has(`claude:${c.id}`) && c.mensagens >= 2);

  await emTransacao(ctx.pool, async (db) => {
    for (const c of novas) {
      await fila.extrairConversa(db, {
        id: c.id,
        titulo: c.titulo,
        texto: c.texto.slice(0, LIMITE_CONVERSA),
        criadaEm: c.criadaEm,
      });
    }
    await auditar(db, ator, "importacao.claude", undefined, { total: conversas.length, novas: novas.length });
    await integracoes.salvar(db, "claude_importacao", {
      config: { ultimaEm: ctx.agora().toISOString(), total: conversas.length, novas: novas.length },
    });
  });
  return { total: conversas.length, novas: novas.length, jaVistas: conversas.length - novas.length };
}

/** Lê a caixa dedicada (IMAP) e agenda a análise de cada e-mail novo. */
export async function sincronizarEmail(ctx: Contexto) {
  if (!ctx.imap) return { novos: 0 };
  const salvo = await integracoes.obter(ctx.pool, "email");
  const desdeUid = Number(salvo?.config.ultimoUid ?? 0);
  const { emails, ultimoUid } = await lerEmailsNovos(ctx.imap, desdeUid);

  await emTransacao(ctx.pool, async (db) => {
    for (const e of emails) {
      const texto = limparCorpoEmail(e.texto);
      if (texto.length < 40) continue;
      await fila.extrairEmail(db, {
        chave: `email:${e.messageId ?? `${ctx.imap!.usuario}:${e.uid}`}`,
        assunto: e.assunto,
        de: e.de,
        data: e.data?.toISOString() ?? null,
        texto: `De: ${e.de}\nAssunto: ${e.assunto}\n\n${texto}`,
      });
    }
    await integracoes.salvar(db, "email", { config: { ultimoUid, ultimaLeituraEm: ctx.agora().toISOString() } });
  });
  return { novos: emails.length };
}
