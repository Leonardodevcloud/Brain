/**
 * Regras de negócio que estão no CÓDIGO da Central (tutts-backend), lidas do GitHub e guardadas
 * no Cérebro: um registro "sistema" por arquivo (ex.: "Taxa de prazo e retornos no BI de entregas").
 * Assim o Argos sabe explicar COMO a Central calcula um número, e não só qual é o número.
 *
 * - Só leitura no GitHub (token fine-grained com "Contents: read" do repositório).
 * - Arquivo que não mudou (mesmo sha) não é lido de novo; arquivo que mudou atualiza o registro (nova versão).
 * - Arquivo que sumiu do repositório deixa o registro como obsoleto.
 * - O código vai para a IA (não é dado pessoal); antes disso, qualquer coisa com cara de segredo é tirada.
 */
import { formatarCodigo } from "@cerebro/core";
import { emTransacao, fontesProcessadas, integracoes, jobs, registros } from "@cerebro/db";
import { SISTEMA_REGRAS_CODIGO, lerJson, type RegrasDoCodigo } from "@cerebro/ia";
import { ATOR_SISTEMA, auditar, type Contexto } from "./contexto.js";
import { JOB, fila } from "./fila.js";

export const VIA_CODIGO = "codigo-central";
const POR_RODADA = 25;
const MIN_CARACTERES = 300;
const MAX_CARACTERES = 60_000;

export interface ArquivoCodigo {
  caminho: string;
  sha: string;
  tamanho: number;
}

export interface ResultadoRegras {
  arquivos: number;
  lidos: number;
  criados: number;
  atualizados: number;
  semRegras: number;
  obsoletos: number;
  restantes: number;
  erros: string[];
}

/** O que muda de lugar para lugar fica aqui (nos testes, um GitHub falso). */
export interface FonteCodigo {
  listar(): Promise<ArquivoCodigo[]>;
  ler(caminho: string): Promise<string>;
  urlDoArquivo(caminho: string): string;
}

export function fonteGithub(cfg: { token: string; repo: string; ramo: string; pastas: string[]; api?: string }): FonteCodigo {
  const api = (cfg.api ?? "https://api.github.com").replace(/\/$/, "");
  const cabecalhos = (aceita: string) => ({
    authorization: `Bearer ${cfg.token}`,
    accept: aceita,
    "x-github-api-version": "2022-11-28",
    "user-agent": "second-brain-tutts",
  });
  const pedir = async (url: string, aceita: string) => {
    // Só GET: o Cérebro nunca escreve no repositório.
    const r = await fetch(url, { method: "GET", headers: cabecalhos(aceita), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status} em ${url.replace(api, "")}: ${(await r.text()).slice(0, 160)}`);
    return r;
  };
  return {
    async listar() {
      const r = await pedir(`${api}/repos/${cfg.repo}/git/trees/${encodeURIComponent(cfg.ramo)}?recursive=1`, "application/vnd.github+json");
      const corpo = (await r.json()) as { tree?: { path: string; type: string; sha: string; size?: number }[] };
      const pastas = cfg.pastas.map((p) => p.replace(/^\/|\/$/g, "") + "/");
      return (corpo.tree ?? [])
        .filter((x) => x.type === "blob" && pastas.some((p) => x.path.startsWith(p)))
        .map((x) => ({ caminho: x.path, sha: x.sha, tamanho: x.size ?? 0 }));
    },
    async ler(caminho) {
      const r = await pedir(
        `${api}/repos/${cfg.repo}/contents/${caminho.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(cfg.ramo)}`,
        "application/vnd.github.raw",
      );
      return r.text();
    },
    urlDoArquivo: (caminho) => `https://github.com/${cfg.repo}/blob/${cfg.ramo}/${caminho}`,
  };
}

/** Os arquivos que interessam: código de regra (serviços, rotas, cálculos), sem migrations e testes. */
export function arquivoDeRegra(a: ArquivoCodigo) {
  if (!/\.(js|ts|mjs|cjs)$/.test(a.caminho)) return false;
  if (/(migration|migracao|\.test\.|\.spec\.|__tests__|\/test\/|\.d\.ts$)/i.test(a.caminho)) return false;
  return a.tamanho === 0 || a.tamanho >= MIN_CARACTERES;
}

/** Tira do código o que pode ser segredo ou dado pessoal antes de mandar para a IA. */
export function limparCodigo(codigo: string) {
  return codigo
    .replace(/(["'`])(?:sk|pk|ghp|gho|github_pat|xox[abp]|AIza|whsec)[-_A-Za-z0-9]{10,}\1/g, "$1[OCULTO]$1")
    .replace(/(["'`])[A-Za-z0-9+/_-]{40,}={0,2}\1/g, "$1[OCULTO]$1")
    .replace(/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]+/gi, "$1://[OCULTO]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF]")
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[CHAVE OCULTA]")
    .slice(0, MAX_CARACTERES);
}

const moduloDe = (caminho: string) => caminho.match(/modules\/([^/]+)/)?.[1] ?? caminho.split("/").slice(-2, -1)[0] ?? "central";
const areaDe = (modulo: string) => (/financ|withdraw|saque|comiss|sinistro/i.test(modulo) ? "financeiro" : /bi|operac|dispon|filas|score/i.test(modulo) ? "operacoes" : "tecnologia");
const NOME_MODULO: Record<string, string> = { bi: "BI", financial: "Financeiro" };

/** O texto do registro: para gente ler e para o Argos achar na busca. */
export function montarConteudoRegras(x: RegrasDoCodigo, a: { caminho: string; sha: string; url: string; lidoEm: string }) {
  const regras = (x.regras ?? [])
    .filter((r) => r?.nome && r?.descricao)
    .slice(0, 15)
    .map((r) => `- **${String(r.nome).trim()}**: ${String(r.descricao).trim()}${r.formula ? `\n  Fórmula: \`${String(r.formula).trim()}\`` : ""}`);
  const endpoints = (x.endpoints ?? []).filter(Boolean).slice(0, 20).map((e) => `- ${String(e).trim()}`);
  const termos = (x.termos ?? []).filter(Boolean).slice(0, 15).map(String);
  return [
    x.resumo?.trim() ?? "",
    regras.length ? `## Regras\n${regras.join("\n")}` : "",
    endpoints.length ? `## De onde vem na tela\n${endpoints.join("\n")}` : "",
    termos.length ? `Também chamado de: ${termos.join(", ")}.` : "",
    `---\nLido automaticamente do código da Central: [\`${a.caminho}\`](${a.url}) (versão ${a.sha.slice(0, 7)}, ${a.lidoEm}). Se o código mudar, este registro é atualizado sozinho.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Uma rodada: lê até 25 arquivos novos ou alterados e grava as regras. Se sobrar arquivo,
 * agenda a próxima rodada (assim uma primeira leitura grande não trava o worker).
 */
/** Andamento da leitura, para o cartão em Integrações mostrar o que está acontecendo (e o erro, se houver). */
async function registrarEstado(ctx: Contexto, parcial: Record<string, unknown>) {
  const atual = (await integracoes.obter(ctx.pool, VIA_CODIGO).catch(() => null))?.config ?? {};
  await integracoes.salvar(ctx.pool, VIA_CODIGO, { config: { ...atual, ...parcial } }).catch(() => undefined);
}

export async function sincronizarRegrasDoCodigo(
  ctx: Contexto,
  opcoes: { forcar?: boolean; fonte?: FonteCodigo; porRodada?: number } = {},
): Promise<ResultadoRegras> {
  try {
    return await sincronizar(ctx, opcoes);
  } catch (erro) {
    // Sem isso o cartão ficaria parado em "ainda não leu" sem dizer por quê.
    await registrarEstado(ctx, { lendoDesde: null, ultimoErro: (erro as Error).message.slice(0, 300), erroEm: ctx.agora().toISOString() });
    throw erro;
  }
}

async function sincronizar(ctx: Contexto, opcoes: { forcar?: boolean; fonte?: FonteCodigo; porRodada?: number }): Promise<ResultadoRegras> {
  await registrarEstado(ctx, { lendoDesde: ctx.agora().toISOString(), ultimoErro: null, feitos: 0, lote: null });
  const ia = ctx.iaRestrita ?? ctx.ia;
  const amb = ctx.ambiente;
  const fonte =
    opcoes.fonte ??
    (amb.CENTRAL_GITHUB_TOKEN
      ? fonteGithub({
          token: amb.CENTRAL_GITHUB_TOKEN,
          repo: amb.CENTRAL_GITHUB_REPO,
          ramo: amb.CENTRAL_GITHUB_RAMO,
          pastas: amb.CENTRAL_GITHUB_PASTAS.split(",").map((p) => p.trim()).filter(Boolean),
        })
      : null);
  if (!fonte) throw new Error("Defina CENTRAL_GITHUB_TOKEN para o Cérebro ler as regras do código da Central.");
  if (!ia) throw new Error("Defina IA_ANALISE_CHAVE: é a IA que transforma o código em regras legíveis.");

  const todos = (await fonte.listar()).filter(arquivoDeRegra);
  const chave = (a: ArquivoCodigo) => `${VIA_CODIGO}:${a.caminho}@${a.sha}`;
  const feitos = opcoes.forcar ? new Set<string>() : await fontesProcessadas.jaProcessadas(ctx.pool, todos.map(chave));
  const pendentes = todos.filter((a) => !feitos.has(chave(a)));
  const lote = pendentes.slice(0, opcoes.porRodada ?? POR_RODADA);
  const res: ResultadoRegras = { arquivos: todos.length, lidos: 0, criados: 0, atualizados: 0, semRegras: 0, obsoletos: 0, restantes: pendentes.length - lote.length, erros: [] };
  await registrarEstado(ctx, { lote: lote.length, feitos: 0, arquivos: todos.length });
  const lidoEm = ctx.agora().toLocaleDateString("pt-BR", { timeZone: "America/Bahia" });

  for (const [i, a] of lote.entries()) {
    if (i) await registrarEstado(ctx, { feitos: i });
    try {
      const codigo = await fonte.ler(a.caminho);
      res.lidos++;
      if (codigo.trim().length < MIN_CARACTERES) {
        await fontesProcessadas.marcar(ctx.pool, chave(a), "irrelevante");
        res.semRegras++;
        continue;
      }
      const resposta = await ia.gerar({
        sistema: SISTEMA_REGRAS_CODIGO,
        mensagens: [{ papel: "user", conteudo: `Arquivo: ${a.caminho}\n\n\`\`\`js\n${limparCodigo(codigo)}\n\`\`\`` }],
        json: true,
        temperatura: 0.1,
        maxTokens: 2200,
        raciocinio: "desligado",
      });
      const x = lerJson<RegrasDoCodigo>(resposta);
      const existente = await registros.buscarPorOrigemExterna(ctx.pool, `${VIA_CODIGO}:${a.caminho}`);
      if (!x.relevante || !(x.regras ?? []).some((r) => r?.nome && r?.descricao)) {
        await fontesProcessadas.marcar(ctx.pool, chave(a), "irrelevante", existente?.id ?? null);
        res.semRegras++;
        continue;
      }
      const modulo = moduloDe(a.caminho);
      const titulo = `${(x.titulo ?? "").trim() || a.caminho.split("/").pop()} (Central · ${NOME_MODULO[modulo] ?? modulo})`.slice(0, 200);
      const conteudo = montarConteudoRegras(x, { caminho: a.caminho, sha: a.sha, url: fonte.urlDoArquivo(a.caminho), lidoEm });
      const dados = { origemExternaId: `${VIA_CODIGO}:${a.caminho}`, via: VIA_CODIGO, arquivo: a.caminho, sha: a.sha, modulo };

      const id = await emTransacao(ctx.pool, async (db) => {
        if (existente) {
          const versao = existente.versao + 1;
          await registros.atualizar(db, existente.id, { titulo, conteudo, dados, versao, status: "vigente" });
          await registros.inserirVersao(db, {
            registroId: existente.id,
            versao,
            titulo,
            conteudo,
            metadados: { sha: a.sha },
            motivo: `O código mudou (versão ${a.sha.slice(0, 7)})`,
            autorId: null,
          });
          await fila.indexar(db, existente.id);
          return existente.id;
        }
        const numero = await registros.proximoNumero(db, "sistema");
        const codigoRegistro = formatarCodigo("sistema", numero);
        const novo = await registros.inserir(db, codigoRegistro, {
          tipo: "sistema",
          titulo,
          conteudo,
          area: areaDe(modulo),
          empresa: "todas",
          // Vem do código, que é a fonte da verdade: entra valendo e se atualiza sozinho.
          status: "vigente",
          confidencialidade: "interno",
          donoId: null,
          revisarEm: null,
          origem: "importacao",
          fonteUrl: fonte.urlDoArquivo(a.caminho),
          clienteRef: null,
          dados,
          criadoPor: null,
        });
        await registros.inserirVersao(db, {
          registroId: novo,
          versao: 1,
          titulo,
          conteudo,
          metadados: { status: "vigente", origem: "importacao", sha: a.sha },
          motivo: "Lido do código da Central",
          autorId: null,
        });
        await auditar(db, ATOR_SISTEMA, "registro.publicado", { entidade: "registro", id: novo }, { codigo: codigoRegistro, via: VIA_CODIGO });
        await fila.indexar(db, novo);
        return novo;
      });
      if (existente) res.atualizados++;
      else res.criados++;
      await fontesProcessadas.marcar(ctx.pool, chave(a), "registro", id);
    } catch (erro) {
      const msg = `${a.caminho}: ${(erro as Error).message.slice(0, 200)}`;
      res.erros.push(msg);
      ctx.log.warn({ erro: msg }, "regras do código: arquivo falhou");
      await fontesProcessadas.marcar(ctx.pool, chave(a), "erro").catch(() => undefined);
    }
  }

  // Arquivo que saiu do repositório: a regra dele deixa de valer.
  if (todos.length) {
    const caminhos = new Set(todos.map((a) => a.caminho));
    for (const r of await registros.listarPorVia(ctx.pool, VIA_CODIGO)) {
      const arquivo = (r.dados as { arquivo?: string } | null)?.arquivo;
      if (arquivo && !caminhos.has(arquivo)) {
        await registros.atualizar(ctx.pool, r.id, { status: "obsoleto" });
        res.obsoletos++;
      }
    }
  }

  const total = (await registros.listarPorVia(ctx.pool, VIA_CODIGO)).length;
  await registrarEstado(ctx, {
    ultimaEm: ctx.agora().toISOString(),
    lendoDesde: null,
    ultimoErro: res.erros.length ? res.erros[0] : null,
    arquivos: res.arquivos,
    registros: total,
    restantes: res.restantes,
    erros: res.erros.length,
  });
  if (res.restantes > 0) await jobs.enfileirar(ctx.pool, JOB.regrasCodigo, {}, { chave: "regras-codigo", maxTentativas: 2 });
  return res;
}

/** Botão "Ler as regras agora" (e o cron diário): enfileira para o worker. */
export async function agendarRegrasDoCodigo(ctx: Contexto, forcar = false) {
  await registrarEstado(ctx, { agendadoEm: ctx.agora().toISOString() });
  await jobs.enfileirar(ctx.pool, JOB.regrasCodigo, { forcar }, { chave: "regras-codigo", maxTentativas: 2 });
}
