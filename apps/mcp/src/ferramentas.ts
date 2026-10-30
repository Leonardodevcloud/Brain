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
import {
  ENDPOINTS_CENTRAL,
  lerRespostaCentral,
  resumoEndpointsCentral,
  CONSULTAS_PRONTAS,
  REGRAS_NEGOCIO,
  carregarCatalogo,
  consultaPronta,
  consultar,
  detalharTabelas,
  resumoDoCatalogo,
  validarSql,
} from "@cerebro/central";
import { lacunas, registros as repoRegistros } from "@cerebro/db";
import { auditar, buscar, conhecimento, painel, tarefas, type Ator, type Contexto } from "@cerebro/servicos";
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
        "o rascunho só vale depois que alguém aprova no Cérebro. " +
        "Para números da operação (disponibilidade, entregas e SLA do BI, faturamento, saques, clientes do CS…) use os dados da Central: " +
        "catalogo_central para achar as tabelas, colunas_central para ver as colunas e consultar_central para rodar um SELECT (só leitura). " +
        "Combinados e próximos passos viram tarefas com criar_tarefa; listar_tarefas mostra o que está aberto.",
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

  // ── Dados da Central (só leitura, sem dados pessoais) ──

  const exigirCentral = () => {
    if (!ctx.central) throw AppError.indisponivel("O banco da Central não está ligado ao Cérebro (falta ARGOS_DB_SENHA).");
    return ctx.central;
  };
  const tabelaMarkdown = (colunas: string[], linhas: Record<string, unknown>[]) => {
    if (!linhas.length) return "(nenhuma linha)";
    const celula = (v: unknown) => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/\|/g, "/").replace(/\n/g, " ");
    return [`| ${colunas.join(" | ")} |`, `| ${colunas.map(() => "---").join(" | ")} |`, ...linhas.map((l) => `| ${colunas.map((c) => celula(l[c])).join(" | ")} |`)].join("\n");
  };

  servidor.registerTool(
    "indicador_central",
    {
      title: "Indicador da Central (mesmo número da tela)",
      description:
        "Chama a MESMA rota que as telas do BI e do BI Financeiro da Central usam: taxa de prazo, entregas, ticket médio, comparativo semanal, garantido, faturamento, margem, saques. " +
        "PREFIRA esta ferramenta para qualquer indicador: o número bate com o que a pessoa vê no sistema. Use consultar_central só quando não houver rota. " +
        "Só leitura; CPF, PIX, contas, telefones e endereços são tirados da resposta.\n\nRotas (* = obrigatório):\n" +
        resumoEndpointsCentral(),
      inputSchema: {
        endpoint: z.enum(ENDPOINTS_CENTRAL.map((e) => e.id) as [string, ...string[]]),
        parametros: z.record(z.string(), z.unknown()).optional().describe("Datas em AAAA-MM-DD; cod_cliente em número ou lista separada por vírgula."),
        tabela: z.string().max(80).optional().describe("Qual lista da resposta mostrar (ex.: porCliente, clientes.semanas). Sem ela, vem a principal."),
      },
      annotations: { readOnlyHint: true },
    },
    ({ endpoint, parametros, tabela }) =>
      seguro(ctx, async () => {
        if (!ctx.centralApi) return falha("A API da Central não está ligada (faltam CENTRAL_API_URL e CENTRAL_API_SEGREDO no serviço mcp). Use consultar_central.");
        const r = await ctx.centralApi.consultar(endpoint, parametros ?? {});
        const { numeros, tabelas } = lerRespostaCentral(r.dados);
        const fim = (c: string) => c.split(".").at(-1)!.toLowerCase();
        const escolhida =
          (tabela ? tabelas.find((t) => t.caminho.toLowerCase() === tabela.toLowerCase() || fim(t.caminho) === tabela.toLowerCase()) : undefined) ??
          (r.endpoint.tabelaPadrao ? tabelas.find((t) => fim(t.caminho) === r.endpoint.tabelaPadrao!.toLowerCase()) : undefined) ??
          [...tabelas].sort((a, b) => b.linhas.length - a.linhas.length)[0];
        await auditar(ctx.pool, ator, "argos.consulta_central", undefined, { origem: `mcp:api:${endpoint}`, linhas: escolhida?.linhas.length ?? 0, ms: r.ms });
        const colunas = escolhida ? [...new Set(escolhida.linhas.slice(0, 50).flatMap((l) => Object.keys(l)))] : [];
        const outras = tabelas.filter((t) => t !== escolhida).map((t) => `${t.caminho} (${t.linhas.length})`);
        const nums = Object.entries(numeros).slice(0, 40).map(([k, v]) => `${k}: ${v}`).join("; ");
        return texto(
          `## ${r.endpoint.descricao.split(/[:.(]/)[0]} — GET ${r.url}\n` +
            (nums ? `Números: ${nums}\n` : "") +
            (escolhida ? `\nTabela ${escolhida.caminho} (${escolhida.linhas.length} linhas):\n${tabelaMarkdown(colunas, escolhida.linhas.slice(0, 200))}` : "\n(sem tabela)") +
            (outras.length ? `\n\nOutras tabelas nesta resposta (use \`tabela\`): ${outras.join("; ")}` : ""),
        );
      }),
  );

  servidor.registerTool(
    "catalogo_central",
    {
      title: "Tabelas da Central",
      description:
        "Lista as tabelas do banco da Central Tutts por módulo (BI, financeiro, disponibilidade, CS, score…), com descrição e tamanho. " +
        "Use antes de consultar_central. Inclui as regras de negócio para não contar errado.",
      inputSchema: { busca: z.string().max(60).optional().describe("Filtra pelo nome da tabela ou do módulo (ex.: 'bi', 'saque').") },
      annotations: { readOnlyHint: true },
    },
    ({ busca }) =>
      seguro(ctx, async () => {
        const catalogo = await carregarCatalogo(exigirCentral());
        const q = busca?.toLowerCase().trim();
        const filtrado = q ? catalogo.filter((t) => t.nome.includes(q) || t.modulo.toLowerCase().includes(q) || (t.descricao ?? "").toLowerCase().includes(q)) : catalogo;
        const prontas = CONSULTAS_PRONTAS.map((c) => `- ${c.nome}: ${c.descricao} Parâmetros: ${JSON.stringify(c.parametros)}`).join("\n");
        return texto(`${resumoDoCatalogo(filtrado)}\n\n## Regras de negócio\n${REGRAS_NEGOCIO}\n\n## Consultas prontas (use consultar_central com "pronta")\n${prontas}`);
      }),
  );

  servidor.registerTool(
    "colunas_central",
    {
      title: "Colunas de tabelas da Central",
      description: "Mostra as colunas e os tipos das tabelas escolhidas, para escrever o SQL.",
      inputSchema: { tabelas: z.array(z.string().max(80)).min(1).max(8) },
      annotations: { readOnlyHint: true },
    },
    ({ tabelas: nomes }) =>
      seguro(ctx, async () => {
        const catalogo = await carregarCatalogo(exigirCentral());
        const existe = new Set(catalogo.map((t) => t.nome));
        const faltam = nomes.filter((n) => !existe.has(n));
        return texto(`${detalharTabelas(catalogo, nomes) || "Nenhuma dessas tabelas existe."}${faltam.length ? `\n\nNão existem: ${faltam.join(", ")}.` : ""}`);
      }),
  );

  servidor.registerTool(
    "consultar_central",
    {
      title: "Consultar dados da Central",
      description:
        "Para indicadores do BI e do BI Financeiro (prazo, ticket, comparativo semanal, garantido, faturamento) use indicador_central: é o número da tela. " +
        "Esta roda uma consulta SÓ DE LEITURA no banco da Central e devolve até 200 linhas. Mande `sql` (um SELECT/WITH em PostgreSQL, " +
        "sem ponto e vírgula e sem prefixo de schema) ou `pronta` com `parametros`. CPF, PIX, dados bancários, senhas e tokens não existem nesse acesso. " +
        "Datas de 'hoje' usam o fuso America/Bahia.",
      inputSchema: {
        sql: z.string().max(8000).optional(),
        pronta: z.enum(CONSULTAS_PRONTAS.map((c) => c.nome) as [string, ...string[]]).optional(),
        parametros: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ sql, pronta, parametros }) =>
      seguro(ctx, async () => {
        const central = exigirCentral();
        if (!sql && !pronta) return falha("Mande `sql` ou `pronta`.");
        if (pronta) {
          const p = consultaPronta(pronta);
          if (!p) return falha("Consulta pronta desconhecida.");
          const r = await p.executar(central, parametros ?? {});
          await auditar(ctx.pool, ator, "argos.consulta_central", undefined, { origem: `mcp:pronta:${pronta}`, linhas: r.linhas.length, ms: r.ms });
          return texto(`## ${r.titulo}\nTotais: ${JSON.stringify(r.totais)}\n\n${tabelaMarkdown(r.colunas, r.linhas.slice(0, 200))}`);
        }
        let validado: string;
        try {
          validado = validarSql(sql!);
        } catch (erro) {
          return falha((erro as Error).message);
        }
        try {
          const r = await consultar(central, validado, [], { limite: 200 });
          await auditar(ctx.pool, ator, "argos.consulta_central", undefined, { origem: "mcp:livre", linhas: r.linhas.length, ms: r.ms });
          return texto(`${r.linhas.length}${r.cortado ? "+ (cortado em 200)" : ""} linhas · ${r.ms} ms\n\n${tabelaMarkdown(r.colunas, r.linhas)}`);
        } catch (erro) {
          return falha(`O banco recusou a consulta: ${(erro as Error).message.slice(0, 400)}. Confira as colunas com colunas_central.`);
        }
      }),
  );

  // ── Tarefas ──

  servidor.registerTool(
    "listar_tarefas",
    {
      title: "Tarefas do Cérebro",
      description: "Lista as tarefas abertas (o que foi combinado em reuniões, registros e conversas).",
      inputSchema: { filtro: z.enum(["minhas", "todas", "atrasadas", "feitas"]).default("todas"), texto: z.string().max(120).optional() },
      annotations: { readOnlyHint: true },
    },
    ({ filtro, texto: busca }) =>
      seguro(ctx, async () => {
        const lista = await tarefas.listarTarefas(ctx, ator, { filtro, texto: busca });
        if (!lista.length) return texto("Nenhuma tarefa com esse filtro.");
        const nome = { a_fazer: "a fazer", fazendo: "fazendo", feita: "feita" } as const;
        return texto(
          lista
            .slice(0, 80)
            .map((t) => `- ${t.codigo} — ${t.titulo} (${nome[t.status]}${t.prazo ? `, prazo ${t.prazo}${t.atrasada ? " ATRASADA" : ""}` : ""}${t.responsavel ? `, ${t.responsavel.nome}` : ""}${t.registros[0] ? `, de ${t.registros[0].codigo}` : ""})`)
            .join("\n"),
        );
      }),
  );

  servidor.registerTool(
    "criar_tarefa",
    {
      title: "Criar tarefa no Cérebro",
      description: "Cria uma tarefa (vale na hora, não precisa de aprovação). Confirme título, responsável e prazo com a pessoa.",
      inputSchema: {
        titulo: z.string().min(3).max(300),
        descricao: z.string().max(5000).optional(),
        responsavel: z.string().max(120).optional().describe("Nome da pessoa ou do time (ex.: 'Leonardo', 'Supervisão SSA')."),
        prazo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("AAAA-MM-DD"),
        cliente: z.string().max(200).optional(),
        registro: z.string().max(20).optional().describe("Código de um registro ligado (ex.: POP-014)."),
      },
    },
    ({ titulo, descricao, responsavel, prazo, cliente, registro }) =>
      seguro(ctx, async () => {
        const ligado = registro ? await repoRegistros.buscarPorCodigo(ctx.pool, registro.trim().toUpperCase()) : null;
        if (registro && !ligado) return falha(`Não encontrei ${registro}.`);
        const t = await tarefas.criarTarefa(
          ctx,
          ator,
          { titulo, descricao: descricao ?? "", responsavelTexto: responsavel, prazo, clienteRef: cliente, registros: ligado ? [ligado.id] : [] },
          { origem: "claude" },
        );
        return texto(`Tarefa ${t.codigo} criada${t.responsavel ? ` para ${t.responsavel.nome}` : ""}${t.prazo ? `, prazo ${t.prazo}` : ""}: ${urlWeb.replace(/\/$/, "")}/tarefas?abrir=${t.codigo}`);
      }),
  );

  servidor.registerTool(
    "atualizar_tarefa",
    {
      title: "Atualizar tarefa",
      description: "Muda a situação (a_fazer, fazendo, feita), o prazo ou o responsável de uma tarefa pelo código (TAR-018).",
      inputSchema: {
        codigo: z.string().max(20),
        status: z.enum(["a_fazer", "fazendo", "feita"]).optional(),
        prazo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        responsavel: z.string().max(120).optional(),
      },
    },
    ({ codigo, status, prazo, responsavel }) =>
      seguro(ctx, async () => {
        const t = await tarefas.atualizarTarefa(ctx, ator, codigo.trim().toUpperCase(), { status, prazo, responsavelTexto: responsavel });
        return texto(`${t.codigo} atualizada: ${t.status}${t.prazo ? `, prazo ${t.prazo}` : ""}${t.responsavel ? `, ${t.responsavel.nome}` : ""}.`);
      }),
  );

  return servidor;
}
