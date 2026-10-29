/**
 * Planilhas anexadas na conversa com o Argos (.xlsx ou .csv).
 * O arquivo é lido no servidor, fica guardado na memória por algumas horas (só para quem enviou)
 * e o agente calcula sobre ele com a ação "planilha": filtros, agrupamentos e métricas feitos aqui,
 * nunca "de cabeça" pela IA. Colunas sensíveis (CPF, PIX, banco, senha) nem entram.
 */
import { randomUUID } from "node:crypto";
import { AppError, type AnexoDTO } from "@cerebro/core";
import { strFromU8, unzipSync } from "fflate";
import type { Ator } from "./contexto.js";

export const LIMITE_PLANILHA_BYTES = 15 * 1024 * 1024;
const MAX_LINHAS = 50_000;
const VALIDADE_MS = 6 * 60 * 60_000;
// Colunas que nunca saem do arquivo: nem para a tela, nem para a IA.
const COLUNA_SENSIVEL = /(^|[_\s])(cpf|pix|chave_?pix|banco|agencia|ag[eê]ncia|conta|conta_?corrente|senha|token|rg|cnh)($|[_\s])/i;

export type Celula = string | number | null;
export interface Aba {
  nome: string;
  colunas: string[];
  linhas: Record<string, Celula>[];
}
interface Anexo {
  id: string;
  dono: string;
  nome: string;
  abas: Aba[];
  ocultas: string[];
  criadoEm: number;
}

const anexos = new Map<string, Anexo>();

function limparVelhos() {
  const agora = Date.now();
  for (const [id, a] of anexos) if (agora - a.criadoEm > VALIDADE_MS) anexos.delete(id);
  while (anexos.size > 200) anexos.delete(anexos.keys().next().value!);
}

const decodificarXml = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** "C12" → coluna 2 (A = 0). */
function indiceColuna(ref: string) {
  const letras = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

const ehNumero = (t: string) => /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(t.trim());
/** "1.234,56" ou "R$ 1.234,56" → 1234.56; texto comum continua texto. */
function numeroBr(t: string): number | null {
  const s = t.trim().replace(/^R\$\s*/, "").replace(/%$/, "");
  if (/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(s) || /^-?\d+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, "").replace(",", "."));
  if (ehNumero(s)) return Number(s);
  return null;
}

/** Datas do Excel chegam como número de dias desde 1899-12-30. */
const COLUNA_DATA = /(data|dia|date|venc|emiss|criad|entreg|solicit)/i;
function dataExcel(n: number) {
  return new Date(Math.round((n - 25569) * 86400_000)).toISOString().slice(0, 10);
}

function nomesUnicos(cabecalho: string[]) {
  const vistos = new Map<string, number>();
  return cabecalho.map((c, i) => {
    const base = c.trim().replace(/\s+/g, " ") || `coluna_${i + 1}`;
    const n = (vistos.get(base) ?? 0) + 1;
    vistos.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
}

/** Primeira linha com texto vira o cabeçalho; o resto vira linhas. */
function montarAba(nome: string, grade: Celula[][]): Aba | null {
  const inicio = grade.findIndex((l) => l.filter((c) => c !== null && String(c).trim() !== "").length >= 2);
  if (inicio < 0) return null;
  const largura = Math.max(...grade.slice(inicio, inicio + 50).map((l) => l.length));
  const colunas = nomesUnicos(Array.from({ length: largura }, (_, i) => String(grade[inicio]![i] ?? "")));
  const linhas: Record<string, Celula>[] = [];
  for (const l of grade.slice(inicio + 1)) {
    if (!l.some((c) => c !== null && String(c).trim() !== "")) continue;
    const linha: Record<string, Celula> = {};
    colunas.forEach((c, i) => {
      let v = l[i] ?? null;
      if (typeof v === "number" && COLUNA_DATA.test(c) && v > 20000 && v < 80000) v = dataExcel(v);
      linha[c] = v;
    });
    linhas.push(linha);
    if (linhas.length >= MAX_LINHAS) break;
  }
  return { nome, colunas, linhas };
}

function lerXlsx(bytes: Uint8Array): Aba[] {
  let zip: Record<string, Uint8Array>;
  try {
    zip = unzipSync(bytes);
  } catch {
    throw AppError.requisicaoInvalida("Não consegui abrir essa planilha. Salve de novo como .xlsx e envie.");
  }
  const compartilhadas = zip["xl/sharedStrings.xml"]
    ? (strFromU8(zip["xl/sharedStrings.xml"]).match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
        decodificarXml((si.match(/<t[^>]*>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")),
      )
    : [];
  const nomes = zip["xl/workbook.xml"] ? [...strFromU8(zip["xl/workbook.xml"]).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodificarXml(m[1]!)) : [];
  const folhas = Object.keys(zip)
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const abas: Aba[] = [];
  folhas.forEach((k, i) => {
    const grade: Celula[][] = [];
    for (const row of strFromU8(zip[k]!).match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const linha: Celula[] = [];
      for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
        const ref = /\br="([A-Z]+)\d+"/.exec(c)?.[1];
        const col = ref ? indiceColuna(ref) : linha.length;
        const bruto = c.match(/<v>([^<]*)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
        let v: Celula;
        if (/t="s"/.test(c)) v = compartilhadas[Number(bruto)] ?? "";
        else if (/t="(str|inlineStr)"/.test(c)) v = decodificarXml(bruto);
        else if (/t="b"/.test(c)) v = bruto === "1" ? "Sim" : "Não";
        else v = bruto === "" ? null : ehNumero(bruto) ? Number(bruto) : decodificarXml(bruto);
        linha[col] = v;
      }
      grade.push(Array.from(linha, (x) => x ?? null));
    }
    const aba = montarAba(nomes[i] ?? `Aba ${i + 1}`, grade);
    if (aba) abas.push(aba);
  });
  return abas;
}

/** CSV com ";" (Excel brasileiro) ou ",", aspas e quebras de linha dentro de aspas. */
function lerCsv(texto: string, nome: string): Aba[] {
  const primeira = texto.split(/\r?\n/, 1)[0] ?? "";
  const sep = (primeira.match(/;/g)?.length ?? 0) > (primeira.match(/,/g)?.length ?? 0) ? ";" : primeira.includes("\t") ? "\t" : ",";
  const grade: Celula[][] = [];
  let linha: Celula[] = [];
  let campo = "";
  let aspas = false;
  const fechar = () => {
    const t = campo.trim();
    linha.push(t === "" ? null : (numeroBr(t) ?? t));
    campo = "";
  };
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i]!;
    if (aspas) {
      if (ch === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (ch === '"') aspas = false;
      else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) fechar();
    else if (ch === "\n") {
      fechar();
      grade.push(linha);
      linha = [];
    } else if (ch !== "\r") campo += ch;
  }
  if (campo || linha.length) {
    fechar();
    grade.push(linha);
  }
  // Cabeçalho sempre texto.
  if (grade[0]) grade[0] = grade[0].map((c) => (c === null ? null : String(c)));
  const aba = montarAba(nome.replace(/\.[^.]+$/, ""), grade);
  return aba ? [aba] : [];
}

/** Lê o arquivo, tira as colunas sensíveis e guarda para a conversa. */
export function guardarPlanilha(ator: Ator, nome: string, bytes: Uint8Array): AnexoDTO {
  if (!ator.usuarioId) throw AppError.semPermissao();
  if (bytes.byteLength > LIMITE_PLANILHA_BYTES) throw AppError.requisicaoInvalida("A planilha passou de 15 MB. Envie só as abas que importam.");
  const ext = nome.toLowerCase().split(".").pop();
  let abas: Aba[];
  if (ext === "xlsx") abas = lerXlsx(bytes);
  else if (ext === "csv" || ext === "txt") abas = lerCsv(new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, ""), nome);
  else throw AppError.requisicaoInvalida("Envie uma planilha .xlsx ou .csv.");
  if (!abas.length) throw AppError.requisicaoInvalida("Não achei uma tabela nessa planilha (cabeçalho na primeira linha com dados).");

  const ocultas = new Set<string>();
  for (const a of abas) {
    const fora = a.colunas.filter((c) => COLUNA_SENSIVEL.test(c.normalize("NFD").replace(/[̀-ͯ]/g, "")));
    for (const c of fora) ocultas.add(c);
    if (fora.length) {
      a.colunas = a.colunas.filter((c) => !fora.includes(c));
      for (const l of a.linhas) for (const c of fora) delete l[c];
    }
  }
  limparVelhos();
  const id = randomUUID();
  anexos.set(id, { id, dono: ator.usuarioId, nome: nome.slice(0, 120), abas, ocultas: [...ocultas], criadoEm: Date.now() });
  return resumoAnexo(anexos.get(id)!);
}

function resumoAnexo(a: Anexo): AnexoDTO {
  return {
    id: a.id,
    nome: a.nome,
    abas: a.abas.map((x) => ({ nome: x.nome, colunas: x.colunas, linhas: x.linhas.length })),
    colunasOcultas: a.ocultas,
  };
}

/** A planilha guardada, só para quem enviou. */
export function lerAnexo(ator: Ator, id: string): Anexo | null {
  const a = anexos.get(id);
  if (!a || a.dono !== ator.usuarioId) return null;
  return a;
}

const numeroDe = (v: Celula): number | null => (typeof v === "number" ? v : typeof v === "string" ? numeroBr(v) : null);

function tipoColuna(a: Aba, c: string): "número" | "data" | "texto" {
  const amostra = a.linhas.slice(0, 200).map((l) => l[c]).filter((v) => v !== null && v !== "");
  if (!amostra.length) return "texto";
  if (amostra.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return "data";
  if (amostra.filter((v) => numeroDe(v ?? null) !== null).length / amostra.length > 0.9) return "número";
  return "texto";
}

/** O que a IA vê da planilha: estrutura, uma amostra e o resumo das colunas de número. */
export function contextoPlanilha(a: Anexo, amostra = 12): { texto: string; linhasAmostra: Record<string, Celula>[] } {
  const partes: string[] = [`Planilha anexada "${a.nome}" (${a.abas.length} aba${a.abas.length > 1 ? "s" : ""}).`];
  const linhasAmostra: Record<string, Celula>[] = [];
  for (const aba of a.abas.slice(0, 5)) {
    const cols = aba.colunas.map((c) => `${c} (${tipoColuna(aba, c)})`);
    const resumo = aba.colunas
      .filter((c) => tipoColuna(aba, c) === "número")
      .slice(0, 12)
      .map((c) => {
        const ns = aba.linhas.map((l) => numeroDe(l[c] ?? null)).filter((n): n is number => n !== null);
        const soma = ns.reduce((s, n) => s + n, 0);
        return `${c}: soma ${arred(soma)}, média ${arred(ns.length ? soma / ns.length : 0)}, mín ${arred(Math.min(...ns))}, máx ${arred(Math.max(...ns))}`;
      });
    const primeiras = aba.linhas.slice(0, amostra);
    linhasAmostra.push(...primeiras);
    partes.push(
      `Aba "${aba.nome}": ${aba.linhas.length} linhas.\nColunas: ${cols.join(", ")}` +
        (resumo.length ? `\nResumo: ${resumo.join("; ")}` : "") +
        `\nPrimeiras ${primeiras.length} linhas:\n${JSON.stringify(primeiras)}`,
    );
  }
  if (a.ocultas.length) partes.push(`(Colunas sensíveis removidas do arquivo: ${a.ocultas.join(", ")}.)`);
  return { texto: partes.join("\n\n"), linhasAmostra };
}

const arred = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export interface ConsultaPlanilha {
  aba?: string | null;
  filtros?: { coluna?: string; op?: string; valor?: unknown }[];
  agrupar?: string[];
  metricas?: { fn?: string; coluna?: string; nome?: string }[];
  ordenar?: { coluna?: string; desc?: boolean } | null;
  limite?: number;
}

const sem = (t: unknown) =>
  String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

/** Acha a coluna pelo nome, tolerando acento e caixa. */
function coluna(aba: Aba, nome: string | undefined): string {
  if (!nome) throw new Error("Faltou o nome da coluna.");
  const achada = aba.colunas.find((c) => c === nome) ?? aba.colunas.find((c) => sem(c) === sem(nome));
  if (!achada) throw new Error(`A coluna "${nome}" não existe. Colunas: ${aba.colunas.join(", ")}.`);
  return achada;
}

function passa(v: Celula, op: string, alvo: unknown): boolean {
  const n = numeroDe(v);
  const na = typeof alvo === "number" ? alvo : numeroBr(String(alvo ?? ""));
  switch (op) {
    case "=":
      return n !== null && na !== null ? n === na : sem(v) === sem(alvo);
    case "!=":
      return n !== null && na !== null ? n !== na : sem(v) !== sem(alvo);
    case ">":
    case "<":
    case ">=":
    case "<=": {
      // Datas em texto ISO comparam como texto; o resto como número.
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        const a = String(alvo);
        return op === ">" ? v > a : op === "<" ? v < a : op === ">=" ? v >= a : v <= a;
      }
      if (n === null || na === null) return false;
      return op === ">" ? n > na : op === "<" ? n < na : op === ">=" ? n >= na : n <= na;
    }
    case "contem":
      return sem(v).includes(sem(alvo));
    default:
      throw new Error(`Operador "${op}" não existe. Use =, !=, >, <, >=, <= ou contem.`);
  }
}

/** Executa um filtro/agrupamento sobre a planilha. Mesmo formato de resultado das consultas ao banco. */
export function consultarPlanilha(a: Anexo, q: ConsultaPlanilha) {
  const inicio = Date.now();
  const aba = (q.aba && (a.abas.find((x) => x.nome === q.aba) ?? a.abas.find((x) => sem(x.nome) === sem(q.aba)))) || a.abas[0]!;
  let linhas = aba.linhas;
  for (const f of q.filtros ?? []) {
    const c = coluna(aba, f.coluna);
    linhas = linhas.filter((l) => passa(l[c] ?? null, f.op ?? "=", f.valor));
  }
  const agrupar = (q.agrupar ?? []).map((c) => coluna(aba, c));
  const metricas = (q.metricas ?? []).map((m) => {
    const fn = m.fn ?? "contagem";
    if (!["soma", "media", "contagem", "min", "max"].includes(fn)) throw new Error(`Métrica "${fn}" não existe. Use soma, media, contagem, min ou max.`);
    const c = fn === "contagem" && !m.coluna ? null : coluna(aba, m.coluna);
    return { fn, c, nome: (m.nome?.trim() || (c ? `${fn}_${c}` : "contagem")).slice(0, 60) };
  });

  let colunas: string[];
  let saida: Record<string, Celula>[];
  if (agrupar.length || metricas.length) {
    const grupos = new Map<string, Record<string, Celula>[]>();
    for (const l of linhas) {
      const chave = JSON.stringify(agrupar.map((c) => l[c] ?? null));
      grupos.set(chave, [...(grupos.get(chave) ?? []), l]);
    }
    if (!agrupar.length && !grupos.size) grupos.set("[]", []);
    const ms = metricas.length ? metricas : [{ fn: "contagem", c: null, nome: "contagem" }];
    colunas = [...agrupar, ...ms.map((m) => m.nome)];
    saida = [...grupos.entries()].map(([chave, ls]) => {
      const linha: Record<string, Celula> = {};
      (JSON.parse(chave) as Celula[]).forEach((v, i) => (linha[agrupar[i]!] = v));
      for (const m of ms) {
        const ns = m.c ? ls.map((l) => numeroDe(l[m.c!] ?? null)).filter((n): n is number => n !== null) : [];
        const soma = ns.reduce((s, n) => s + n, 0);
        linha[m.nome] =
          m.fn === "contagem" ? (m.c ? ls.filter((l) => l[m.c!] !== null && l[m.c!] !== "").length : ls.length)
          : m.fn === "soma" ? arred(soma)
          : m.fn === "media" ? arred(ns.length ? soma / ns.length : 0)
          : m.fn === "min" ? (ns.length ? Math.min(...ns) : null)
          : ns.length ? Math.max(...ns) : null;
      }
      return linha;
    });
  } else {
    colunas = aba.colunas;
    saida = linhas;
  }
  if (q.ordenar?.coluna) {
    const c = colunas.find((x) => sem(x) === sem(q.ordenar!.coluna)) ?? coluna(aba, q.ordenar.coluna);
    const desc = q.ordenar.desc !== false;
    saida = [...saida].sort((x, y) => {
      const a1 = numeroDe(x[c] ?? null), b1 = numeroDe(y[c] ?? null);
      const cmp = a1 !== null && b1 !== null ? a1 - b1 : String(x[c] ?? "").localeCompare(String(y[c] ?? ""), "pt-BR");
      return desc ? -cmp : cmp;
    });
  }
  const limite = Math.min(500, Math.max(1, q.limite ?? 200));
  return {
    aba: aba.nome,
    colunas,
    linhas: saida.slice(0, limite),
    cortado: saida.length > limite,
    total: saida.length,
    ms: Date.now() - inicio,
  };
}
