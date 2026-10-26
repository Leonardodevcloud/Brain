import { createHash } from "node:crypto";
import { AREAS, AppError, CONFIDENCIALIDADES, type Area, type Confidencialidade } from "@cerebro/core";
import { emTransacao, registros, type Executor } from "@cerebro/db";
import { strFromU8, unzipSync } from "fflate";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { criarRegistroEm, obterRegistro } from "./registros.js";

export const LIMITE_DOCUMENTO_BYTES = 25 * 1024 * 1024;
const LIMITE_TEXTO = 500_000;

/** Formatos aceitos: o texto deles vira conhecimento do Cérebro. */
const FORMATOS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};
export const EXTENSOES_DOCUMENTO = Object.keys(FORMATOS);

const extensao = (nome: string) => nome.toLowerCase().split(".").pop() ?? "";

const decodificarXml = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Word: um parágrafo por <w:p>, títulos viram "##", listas viram "-". */
function textoDocx(zip: Record<string, Uint8Array>): string {
  const xml = zip["word/document.xml"];
  if (!xml) throw AppError.requisicaoInvalida("Esse .docx não tem o conteúdo principal. Salve de novo pelo Word e envie.");
  const corpo = strFromU8(xml);
  const paragrafos = corpo.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? [];
  return paragrafos
    .map((p) => {
      const texto = decodificarXml((p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")).trim();
      if (!texto) return "";
      if (/<w:pStyle w:val="(Heading|Ttulo|Titulo|T[ií]tulo)\s?\d?"/i.test(p)) return `## ${texto}`;
      if (/<w:numPr>/.test(p)) return `- ${texto}`;
      return texto;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Excel: cada aba vira uma tabela em texto (linhas separadas por " | "). */
function textoXlsx(zip: Record<string, Uint8Array>): string {
  const compartilhadas = zip["xl/sharedStrings.xml"]
    ? (strFromU8(zip["xl/sharedStrings.xml"]).match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
        decodificarXml((si.match(/<t[^>]*>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")),
      )
    : [];
  const nomes = zip["xl/workbook.xml"] ? [...strFromU8(zip["xl/workbook.xml"]).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodificarXml(m[1]!)) : [];
  const abas = Object.keys(zip)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return abas
    .map((k, i) => {
      const linhas = (strFromU8(zip[k]!).match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []).map((row) =>
        (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? [])
          .map((c) => {
            const v = c.match(/<v>([^<]*)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
            return /t="s"/.test(c) ? (compartilhadas[Number(v)] ?? "") : decodificarXml(v);
          })
          .join(" | ")
          .replace(/( \| )+$/, ""),
      );
      const uteis = linhas.filter((l) => l.replace(/[\s|]/g, ""));
      return uteis.length ? `## ${nomes[i] ?? `Aba ${i + 1}`}\n\n${uteis.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/** PowerPoint: o texto de cada slide, na ordem. */
function textoPptx(zip: Record<string, Uint8Array>): string {
  const slides = Object.keys(zip)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return slides
    .map((k, i) => {
      const paragrafos = (strFromU8(zip[k]!).match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
        .map((p) => decodificarXml((p.match(/<a:t>([^<]*)<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")).trim())
        .filter(Boolean);
      return paragrafos.length ? `## Slide ${i + 1}\n\n${paragrafos.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function textoPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[])
    .map((pagina) => pagina.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Extrai o texto do arquivo. Formato desconhecido ou sem texto = erro explicando o que fazer. */
export async function extrairTexto(nome: string, bytes: Uint8Array): Promise<string> {
  const ext = extensao(nome);
  if (!FORMATOS[ext]) {
    throw AppError.requisicaoInvalida(`Formato .${ext} não é aceito. Envie ${EXTENSOES_DOCUMENTO.map((e) => `.${e}`).join(", ")}.`);
  }
  let texto: string;
  try {
    if (ext === "pdf") texto = await textoPdf(bytes);
    else if (ext === "txt" || ext === "md" || ext === "csv") texto = new TextDecoder("utf-8").decode(bytes);
    else {
      const zip = unzipSync(bytes, { filter: (f) => f.name.endsWith(".xml") && f.originalSize < 50 * 1024 * 1024 });
      texto = ext === "docx" ? textoDocx(zip) : ext === "xlsx" ? textoXlsx(zip) : textoPptx(zip);
    }
  } catch (erro) {
    if (erro instanceof AppError) throw erro;
    throw AppError.requisicaoInvalida(`Não consegui ler esse arquivo (${(erro as Error).message.slice(0, 120)}). Ele pode estar protegido por senha ou corrompido.`);
  }
  // eslint-disable-next-line no-control-regex
  texto = texto.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  if (texto.length < 20) {
    throw AppError.requisicaoInvalida(
      ext === "pdf"
        ? "Esse PDF não tem texto (parece digitalizado como imagem). Envie a versão original em Word ou um PDF com texto selecionável."
        : "Não encontrei texto nesse arquivo.",
    );
  }
  return texto.length > LIMITE_TEXTO ? `${texto.slice(0, LIMITE_TEXTO)}\n\n[… documento cortado: o restante passou do limite de leitura]` : texto;
}

export interface EnvioDocumento {
  nome: string;
  bytes: Uint8Array;
  titulo?: string;
  area?: string;
  confidencialidade?: string;
  clienteRef?: string | null;
}

const tituloDoNome = (nome: string) => {
  const t = nome
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return t ? t.charAt(0).toLocaleUpperCase("pt-BR") + t.slice(1) : "Documento";
};

/** O primeiro título do texto (## do Word, ou a 1ª linha curta de um .txt/.md); senão, o nome do arquivo. */
function tituloDoTexto(nome: string, texto: string) {
  const titulo = /^#{1,3}\s+(.{3,120})$/m.exec(texto.slice(0, 3000))?.[1];
  if (titulo) return titulo.trim();
  const ext = extensao(nome);
  const primeira = texto.split("\n").find((l) => l.trim())?.trim() ?? "";
  if ((ext === "txt" || ext === "md") && primeira.length >= 3 && primeira.length <= 100 && !/[.:;]$/.test(primeira)) return primeira;
  return tituloDoNome(nome);
}

/**
 * Guarda o documento e transforma o texto dele em conhecimento: vira um registro do tipo Documento,
 * entra na busca, no Argos, no Claude e no mapa. Quem é administrador publica na hora; os outros
 * enviam como rascunho para aprovação.
 */
export async function enviarDocumento(ctx: Contexto, ator: Ator, d: EnvioDocumento) {
  if (!ator.usuarioId) throw AppError.semPermissao("Faça login para enviar documentos.");
  if (d.bytes.byteLength > LIMITE_DOCUMENTO_BYTES) throw AppError.requisicaoInvalida("O arquivo passa de 25 MB. Divida em partes menores.");
  const nome = d.nome.replace(/[\\/]/g, "_").slice(0, 200);
  const sha256 = createHash("sha256").update(d.bytes).digest("hex");
  const repetido = await ctx.pool.query<{ codigo: string }>(
    `SELECT r.codigo FROM cerebro.arquivos a JOIN cerebro.registros r ON r.id = a.registro_id WHERE a.sha256 = $1 AND r.status <> 'descartado'`,
    [sha256],
  );
  if (repetido.rows[0]) throw AppError.conflito(`Esse arquivo já foi enviado (${repetido.rows[0].codigo}).`);

  const texto = await extrairTexto(nome, d.bytes);
  const area: Area = (AREAS as readonly string[]).includes(d.area ?? "") ? (d.area as Area) : "operacoes";
  const confidencialidade: Confidencialidade = (CONFIDENCIALIDADES as readonly string[]).includes(d.confidencialidade ?? "")
    ? (d.confidencialidade as Confidencialidade)
    : "interno";
  const ext = extensao(nome);

  const id = await emTransacao(ctx.pool, async (db) => {
    // Um envio que repetiu o arquivo e foi descartado antes: libera o hash para o novo.
    await db.query(
      `DELETE FROM cerebro.arquivos a USING cerebro.registros r WHERE a.registro_id = r.id AND a.sha256 = $1 AND r.status = 'descartado'`,
      [sha256],
    );
    const registroId = await criarRegistroEm(
      db,
      ctx,
      ator,
      {
        tipo: "documento",
        titulo: (d.titulo?.trim() || tituloDoTexto(nome, texto)).slice(0, 200),
        conteudo: texto,
        area,
        empresa: "todas",
        confidencialidade,
        clienteRef: d.clienteRef?.trim() || null,
        dados: { arquivo: { nome, mime: FORMATOS[ext], tamanho: d.bytes.byteLength, paginas: null } },
        publicar: ator.papel === "admin",
        relacoes: [],
      },
      { origem: "upload" },
    );
    await salvarArquivo(db, registroId, { nome, mime: FORMATOS[ext]!, bytes: d.bytes, sha256, autorId: ator.usuarioId });
    return registroId;
  });
  await auditar(ctx.pool, ator, "documento.enviado", { entidade: "registro", id }, { nome, tamanho: d.bytes.byteLength });
  return obterRegistro(ctx, id);
}

async function salvarArquivo(db: Executor, registroId: string, a: { nome: string; mime: string; bytes: Uint8Array; sha256: string; autorId: string | null }) {
  await db.query(
    `INSERT INTO cerebro.arquivos (registro_id, nome, mime, tamanho, sha256, conteudo, criado_por) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [registroId, a.nome, a.mime, a.bytes.byteLength, a.sha256, Buffer.from(a.bytes), a.autorId],
  );
}

/** O arquivo original, para baixar. */
export async function baixarArquivo(ctx: Contexto, registroIdOuCodigo: string) {
  const r = /^[0-9a-f-]{36}$/i.test(registroIdOuCodigo)
    ? await registros.buscarPorId(ctx.pool, registroIdOuCodigo)
    : await registros.buscarPorCodigo(ctx.pool, registroIdOuCodigo.toUpperCase());
  if (!r) throw AppError.naoEncontrado("O documento");
  const { rows } = await ctx.pool.query<{ nome: string; mime: string; conteudo: Buffer }>(
    `SELECT nome, mime, conteudo FROM cerebro.arquivos WHERE registro_id = $1 ORDER BY criado_em DESC LIMIT 1`,
    [r.id],
  );
  if (!rows[0]) throw AppError.naoEncontrado("O arquivo original");
  return rows[0];
}
