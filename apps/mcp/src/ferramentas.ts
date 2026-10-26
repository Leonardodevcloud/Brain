import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AREAS,
  AppError,
  NOME_TIPO,
  TIPOS_REGISTRO,
  esquemaCriarRegistro,
  type FonteDTO,
  type RegistroResumoDTO,
} from "@cerebro/core";
import { lacunas, registros as repoRegistros } from "@cerebro/db";
import { buscar, conhecimento, painel, type Ator, type Contexto } from "@cerebro/servicos";
import { z } from "zod";

const texto = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const falha = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function linhaResumo(r: RegistroResumoDTO) {
  const revisar = r.revisarEm ? ` · revisar em ${r.revisarEm}` : "";
  return `- ${r.codigo} — ${r.titulo} (${NOME_TIPO[r.tipo]}, ${r.status}, v${r.versao}${revisar})`;
}

function formatarFontes(fontes: FonteDTO[], urlWeb: string) {
  return fontes
    .map(
      (f) =>
        `[${f.indice}] ${f.codigo} — ${f.titulo} (${NOME_TIPO[f.tipo]}, ${f.status}, v${f.versao})\n` +
        `${f.trecho}\nLink: ${urlWeb.replace(/\/$/, "")}/registros/${f.codigo}`,
    )
    .join("\n\n");
}

/** Erros de negócio voltam como texto para o Claude explicar; o resto vai para o log. */
async function seguro<T>(ctx: Contexto, fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (erro) {
    if (erro instanceof AppError) return falha(erro.message);
    ctx.log.error({ erro }, "falha numa ferramenta do MCP");
    return falha("O Cérebro não conseguiu concluir agora. Tente de novo em instantes.");
  }
}

/**
 * Um servidor MCP por requisição, já amarrado a quem está chamando.
 * O Claude lê o conhecimento vigente e salva rascunhos — nunca publica.
 */
export function criarServidorMcp(ctx: Contexto, ator: Ator) {
  const urlWeb = ctx.ambiente.URL_WEB;
  const servidor = new McpServer(
    { name: "cerebro-tutts", version: "0.1.0" },
    {
      instructions:
        "Base de conhecimento oficial da Central Tutts (POPs, decisões, regras, clientes, atas). " +
        "Antes de responder sobre como a operação funciona, use buscar_conhecimento e cite os códigos (ex.: POP-014). " +
        "Quando a conversa produzir uma decisão, regra ou procedimento novo, ofereça salvar com salvar_rascunho — " +
        "o rascunho só vale depois que alguém aprova no Cérebro.",
    },
  );

  servidor.registerTool(
    "buscar_conhecimento",
    {
      title: "Buscar no Cérebro",
      description:
        "Busca POPs, decisões, regras, fichas de clientes e atas vigentes da Central Tutts. " +
        "Use para qualquer pergunta sobre processos, regras, clientes ou decisões passadas. Devolve trechos numerados com o código do registro.",
      inputSchema: {
        pergunta: z.string().min(3).max(1000).describe("A pergunta ou o assunto, em linguagem natural."),
        tipo: z.enum(TIPOS_REGISTRO).optional().describe("Restringe a um tipo de registro."),
        area: z.enum(AREAS).optional().describe("Restringe a uma área."),
        cliente: z.string().max(120).optional().describe("Nome do cliente, quando a pergunta for sobre um cliente."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ pergunta, tipo, area, cliente }) =>
      seguro(ctx, async () => {
        // Conteúdo restrito não sai para IA externa; quem precisa abre no Cérebro.
        const fontes = await buscar(ctx, { pergunta, tipo, area, clienteRef: cliente, incluirRascunhos: false, incluirRestritos: false });
        if (!fontes.length) {
          await lacunas.registrar(ctx.pool, pergunta, ator.usuarioId, "mcp");
          return texto(
            "Nada registrado no Cérebro sobre isso. A pergunta foi anotada como lacuna de documentação. " +
              "Se a conversa chegar a uma resposta, ofereça salvar com salvar_rascunho.",
          );
        }
        const avisos = fontes.filter((f) => f.status === "revisar").map((f) => f.codigo);
        const aviso = avisos.length ? `\n\nAtenção: ${avisos.join(", ")} está em revisão — confirme antes de seguir.` : "";
        return texto(`${formatarFontes(fontes, urlWeb)}${aviso}`);
      }),
  );

  servidor.registerTool(
    "ler_registro",
    {
      title: "Ler registro completo",
      description: "Lê o conteúdo completo e o histórico de um registro pelo código (ex.: POP-014, DEC-003).",
      inputSchema: { codigo: z.string().min(3).max(20).describe("Código do registro, como POP-014.") },
      annotations: { readOnlyHint: true },
    },
    ({ codigo }) =>
      seguro(ctx, async () => {
        const r = await conhecimento.obterRegistro(ctx, codigo.trim().toUpperCase());
        if (r.confidencialidade === "restrito") {
          return falha(`${r.codigo} é restrito e não é enviado ao Claude. Abra em ${urlWeb.replace(/\/$/, "")}/registros/${r.codigo}.`);
        }
        const relacoes = r.relacoes.map((x) => `- ${x.tipo}: ${x.registro.codigo} — ${x.registro.titulo}`).join("\n");
        return texto(
          [
            `# ${r.codigo} — ${r.titulo}`,
            `${NOME_TIPO[r.tipo]} · ${r.status} · v${r.versao} · dono: ${r.dono?.nome ?? "—"} · revisar em ${r.revisarEm ?? "—"}`,
            r.conteudo,
            relacoes ? `## Relacionados\n${relacoes}` : "",
            `Última alteração: ${r.versoes[0]?.motivo ?? "—"} (${r.versoes[0]?.criadoEm.slice(0, 10) ?? "—"})`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }),
  );

  servidor.registerTool(
    "listar_pendencias",
    {
      title: "Pendências do Cérebro",
      description: "Lista o que espera aprovação (rascunhos) e o que venceu a data de revisão.",
      annotations: { readOnlyHint: true },
    },
    () =>
      seguro(ctx, async () => {
        const inicio = await painel.resumoInicio(ctx);
        const parte = (titulo: string, itens: RegistroResumoDTO[]) =>
          `## ${titulo}\n${itens.length ? itens.map(linhaResumo).join("\n") : "Nada por aqui."}`;
        return texto([parte("Para aprovar", inicio.paraRevisar), parte("Revisão vencida ou próxima", inicio.vencidos)].join("\n\n"));
      }),
  );

  servidor.registerTool(
    "salvar_rascunho",
    {
      title: "Salvar rascunho no Cérebro",
      description:
        "Salva uma decisão, procedimento, regra, ocorrência ou nota que surgiu nesta conversa como RASCUNHO. " +
        "Alguém revisa e aprova no Cérebro antes de valer. Confirme com a pessoa o título e o texto antes de salvar.",
      inputSchema: {
        tipo: z.enum(TIPOS_REGISTRO).describe("pop, decisao, ocorrencia, politica, cliente, sistema, indicador, reuniao ou nota."),
        titulo: z.string().min(3).max(200),
        conteudo: z.string().min(10).max(50_000).describe("Texto completo, em Markdown. Para POP: objetivo, quando usar e passos."),
        area: z.enum(AREAS).optional(),
        cliente: z.string().max(120).optional(),
        substitui: z.string().max(20).optional().describe("Código do registro que este substitui, se houver."),
      },
    },
    ({ tipo, titulo, conteudo, area, cliente, substitui }) =>
      seguro(ctx, async () => {
        const relacoes = [];
        if (substitui) {
          const antigo = await repoRegistros.buscarPorCodigo(ctx.pool, substitui.trim().toUpperCase());
          if (!antigo) return falha(`Não encontrei ${substitui} para marcar como substituído.`);
          relacoes.push({ destinoId: antigo.id, tipo: "substitui" as const });
        }
        const entrada = esquemaCriarRegistro.parse({ tipo, titulo, conteudo, area, clienteRef: cliente, relacoes });
        const r = await conhecimento.criarRegistro(ctx, ator, entrada, { origem: "claude", sempreRascunho: true });
        return texto(
          `Rascunho ${r.codigo} salvo. Ele aparece em "Revisar" no Cérebro e só passa a valer depois de aprovado: ` +
            `${urlWeb.replace(/\/$/, "")}/registros/${r.codigo}`,
        );
      }),
  );

  return servidor;
}
