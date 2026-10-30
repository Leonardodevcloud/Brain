import {
  CONSULTAS_PRONTAS,
  REGRAS_NEGOCIO,
  carregarCatalogo,
  consultaPronta,
  consultar,
  detalharTabelas,
  lerRespostaCentral,
  resumoEndpointsCentral,
  resumoDoCatalogo,
  type EndpointCentral,
  validarSql,
  type TabelaCatalogo,
} from "@cerebro/central";
import { NOME_TIPO, TIPOS_REGISTRO, esquemaCriarRegistro, type DadosCentralDTO, type FonteDTO, type GraficoDTO, type MemoriaUsadaDTO, type TipoRegistro } from "@cerebro/core";
import { registros, usuarios } from "@cerebro/db";
import {
  SISTEMA_AGENTE,
  embrulharDados,
  lerJson,
  mascarar,
  montarContextoAgente,
  restaurar,
  type Mensagem,
  type PassoAgente,
} from "@cerebro/ia";
import { buscar } from "./busca.js";
import { auditar, hojeLocal, type Ator, type Contexto } from "./contexto.js";
import { resumoInicio } from "./painel.js";
import { criarReuniao } from "./agenda.js";
import { criarTarefa, listarTarefas } from "./tarefas.js";
import { criarRegistro } from "./registros.js";
import { planoRapido } from "./central.js";
import { consultarPlanilha, contextoPlanilha, lerAnexo } from "./planilhas.js";

/** Uma troca anterior da conversa, para o Argos entender "e em Salvador?". */
export interface TurnoAnterior {
  pergunta: string;
  resposta: string;
  /** Quando a troca aconteceu (ISO). Uma conversa reaberta no dia seguinte: "ontem" daquela troca é outra data. */
  em?: string;
}

// "desses", "e ontem?", "quantos deles…": continua o assunto da troca anterior.
const CONTINUACAO = /^(e |mas |entao |e ai|e quanto|e qual|e quem|e os|e as)|\b(desse|dessa|desses|dessas|disso|deste|destes|deles|delas|nesse|nessa|nesses|nessas|neles|nelas|daquele|daqueles|mesmo periodo|mesmo dia|esse periodo|esses|essas)\b/;

const semAcentoMin = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/** "29/10/2026 17:40" no fuso da Bahia. */
const dataHora = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Bahia", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export interface RespostaAgente {
  fala: string;
  analise: string | null;
  dados: DadosCentralDTO | null;
  fontes: FonteDTO[];
  abrir: string | null;
  rascunho: { id: string; codigo: string } | null;
  tarefa: { id: string; codigo: string } | null;
  passos: number;
  /** Quanto cada etapa levou (ms). */
  tempos: Record<string, number>;
  /** A fala é uma pergunta de volta: a interface já fica ouvindo a resposta. */
  confirmar: boolean;
  /** Memórias do Cérebro que a IA disse ter aplicado. */
  memorias: MemoriaUsadaDTO[];
}

/** Quantas memórias do Cérebro acompanham cada pergunta. */
const MEMORIAS_POR_PERGUNTA = 5;

const MAX_PASSOS = 8;
const LINHAS_PARA_IA = 40;
const LINHAS_PARA_TELA = 50;
// Colunas com nomes de pessoas: o valor é mascarado antes de ir para a IA.
const COLUNA_DE_PESSOA =
  /(^|_)(nome_prof|nome_profissional|profissional|motoboy|user_name|full_name|nome_motoboy|colaborador|funcionario|vendedor|gestor|responsavel|nome_completo|supervisor|atendente|solicitante)($|_)/i;
// Em tabelas de pessoas, até a coluna "nome" é de pessoa.
const TABELA_DE_PESSOA = /(profission|motoboy|usuario|users|colaborador|funcionario|^rh_|recrut|candidat)/i;

interface Resultado {
  id: string;
  titulo: string;
  origem: "pronta" | "livre" | "planilha" | "central";
  sql: string;
  colunas: string[];
  linhas: Record<string, unknown>[];
  cortado: boolean;
  totais: DadosCentralDTO["totais"];
  tabelas: string[];
  ms: number;
}

// Perguntas de "como fazemos" vão para o conhecimento, não para a consulta pronta.
const PERGUNTA_DE_PROCESSO = /\b(como (funciona|fazer|tratamos|trata|e o processo)|qual (o|a) (regra|politica|procedimento|processo)|pop|procedimento)\b/;

/** A consulta pronta que quase certamente responde a pergunta ("como está a disponibilidade?"), para já ir buscando. */
function preBuscaProvavel(pergunta: string) {
  const t = pergunta.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (PERGUNTA_DE_PROCESSO.test(t)) return null;
  const plano = planoRapido(pergunta);
  return plano && consultaPronta(plano.ferramenta) ? plano : null;
}

async function rodarPronta(ctx: Contexto, nome: string, parametros: Record<string, unknown>): Promise<Omit<Resultado, "id">> {
  const pronta = consultaPronta(nome);
  if (!pronta) throw new Error(`Consulta pronta "${nome}" não existe. Use: ${CONSULTAS_PRONTAS.map((c) => c.nome).join(", ")}.`);
  const x = await pronta.executar(ctx.central!, parametros);
  return { titulo: x.titulo, origem: "pronta", sql: x.sql, colunas: x.colunas, linhas: x.linhas, cortado: x.cortado, totais: x.totais, tabelas: [], ms: x.ms };
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

/** Agente do Argos: entende a pergunta, consulta o que precisar (em etapas) e responde. */
export async function agenteArgos(
  ctx: Contexto,
  ator: Ator,
  pergunta: string,
  historico: TurnoAnterior[] = [],
  opcoes: { anexo?: string | null } = {},
): Promise<RespostaAgente> {
  const ia = ctx.ia!;
  const inicio = Date.now();
  const tempos: Record<string, number> = {};
  // Pergunta de continuação herda o recorte da conversa: não adianta adivinhar uma consulta "padrão" (ex.: 30 dias).
  const continuacao = historico.length > 0 && CONTINUACAO.test(semAcentoMin(pergunta));
  const plano = ctx.central && !continuacao ? preBuscaProvavel(pergunta) : null;
  const processo = PERGUNTA_DE_PROCESSO.test(pergunta.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

  // A memória do Cérebro acompanha TODA pergunta. Perguntas curtas de continuação ("e ontem?")
  // buscam também pelo assunto da pergunta anterior. Rascunhos entram (são as memórias recém-guardadas);
  // conteúdo restrito nunca vai para a IA externa.
  const anterior = historico.at(-1)?.pergunta ?? "";
  const consultaMemoria = pergunta.length < 60 && anterior ? `${pergunta} ${anterior}`.slice(0, 900) : pergunta;
  const anexo = opcoes.anexo ? lerAnexo(ator, opcoes.anexo) : null;

  // Tudo o que não depende da IA sai junto: quem pergunta, o catálogo, a memória e, se der para prever, os dados.
  const [usuario, leitura, preBusca, memoria] = await Promise.all([
    ator.usuarioId ? usuarios.buscarPorId(ctx.pool, ator.usuarioId).catch(() => null) : null,
    ctx.central ? carregarCatalogo(ctx.central).then((c) => ({ c, erro: null }), (erro: Error) => ({ c: [] as TabelaCatalogo[], erro })) : null,
    plano ? rodarPronta(ctx, plano.ferramenta, plano.parametros).catch(() => null) : null,
    buscar(ctx, { pergunta: consultaMemoria, incluirRascunhos: true, incluirRestritos: false }).catch((erro: Error) => {
      ctx.log.warn({ erro: erro.message }, "argos: memória indisponível");
      return [] as FonteDTO[];
    }),
  ]);
  const memorias = memoria.slice(0, MEMORIAS_POR_PERGUNTA);
  tempos.preparo = Date.now() - inicio;
  const pessoa = usuario?.nome?.trim() || "um gestor da Central";

  let catalogo: TabelaCatalogo[] = [];
  let avisoCentral = "";
  if (!ctx.central) {
    avisoCentral = "O banco da Central ainda não está ligado ao Argos (falta a ARGOS_DB_SENHA). Diga isso se a pergunta precisar de dados.";
  } else if (leitura?.erro) {
    avisoCentral = "O banco da Central está fora do ar agora.";
    ctx.log.warn({ erro: leitura.erro.message }, "catálogo da Central indisponível");
  } else catalogo = leitura?.c ?? [];
  const nomesTabelas = new Set(catalogo.map((t) => t.nome));

  const agora = ctx.agora();
  const sistema =
    `${SISTEMA_AGENTE}\n\n` +
    montarContextoAgente({
      hoje: hojeLocal(agora),
      pessoa,
      regras: REGRAS_NEGOCIO,
      prontas: CONSULTAS_PRONTAS.map((c) => `- ${c.nome}: ${c.descricao} Parâmetros: ${JSON.stringify(c.parametros)}`).join("\n"),
      catalogo: catalogo.length ? resumoDoCatalogo(catalogo) : avisoCentral,
      endpoints: ctx.centralApi ? resumoEndpointsCentral() : "",
    });

  // Uma única máscara para a conversa inteira: o mesmo nome vira sempre o mesmo marcador.
  const mapa = new Map<string, string>();
  const esconder = (texto: string, nomes: string[] = []) => mascarar(texto, { nomes, mapaAnterior: mapa }).texto;

  const mensagens: Mensagem[] = [];
  // O que a resposta anterior MOSTROU (tabela, totais, recorte) vai na mensagem seguinte da pessoa,
  // como contexto, e não dentro da fala do assistente: senão a IA imita e passa a "falar" a tabela.
  let contextoAnterior = "";
  const comContexto = (texto: string) =>
    contextoAnterior ? `Dados que você mostrou na resposta anterior (só contexto; NÃO repita isto na fala):\n${embrulharDados(contextoAnterior)}\n\n${texto}` : texto;
  for (const t of historico.slice(-8)) {
    // O histórico pode trazer nomes de pessoas (respostas e tabelas anteriores): também vão mascarados.
    const nomes = nomesNoTexto(`${t.pergunta}\n${t.resposta}`);
    const quando = t.em && !Number.isNaN(Date.parse(t.em)) ? ` (feita em ${dataHora(t.em)})` : "";
    const { fala: falaAnterior, contexto } = separarContexto(t.resposta);
    mensagens.push({ papel: "user", conteudo: esconder(comContexto(`Pergunta${quando}:\n${embrulharDados(t.pergunta)}`), nomes) });
    // Mascara antes de virar JSON (no JSON a quebra de linha vira "\\n" e gruda no nome).
    mensagens.push({ papel: "assistant", conteudo: json({ acao: "responder", fala: esconder(falaAnterior, nomes) }) });
    contextoAnterior = esconder(contexto, nomes);
  }
  // Indicador que tem rota na Central: a dica aponta qual usar (é o número da tela).
  const sugerido = ctx.centralApi ? endpointProvavel(pergunta) : null;
  const dica = sugerido
    ? `INDICADOR DA TELA: para esta pergunta use primeiro {"acao":"central","endpoint":"${sugerido.id}"} (${sugerido.motivo}). É o mesmo cálculo que a pessoa vê no BI; SQL só se essa rota não trouxer o dado.`
    : "";
  // Conversa reaberta em outro dia: avisa a IA explicitamente.
  const ultima = historico.at(-1)?.em;
  const ultimaEm = ultima && !Number.isNaN(Date.parse(ultima)) && hojeLocal(new Date(ultima)) !== hojeLocal(agora) ? ultima : null;
  const hora = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
  // Regras com um cálculo pronto ligado (dados.calculo): a IA só escolhe o período, a conta é do servidor.
  const calculos = new Map<string, { nome: string; parametros: Record<string, unknown> }>();
  if (memorias.length) {
    const completos = await registros.buscarPorIds(ctx.pool, memorias.map((m) => m.registroId)).catch(() => []);
    for (const r of completos) {
      const c = (r.dados as { calculo?: { nome?: string; parametros?: Record<string, unknown> } } | null)?.calculo;
      if (r.status === "vigente" && c?.nome && consultaPronta(c.nome)) calculos.set(r.id, { nome: c.nome, parametros: c.parametros ?? {} });
    }
  }
  const textoMemoria = memorias.length
    ? memorias
        .map((m) => {
          const selo = m.status === "rascunho" ? " [não revisada]" : m.status === "vigente" && m.tipo !== "nota" ? " [regra vigente]" : "";
          const c = calculos.get(m.registroId);
          const pronto = c
            ? `\nCÁLCULO PRONTO desta regra (use exatamente isto, só preenchendo inicio/fim): ${json({ acao: "pronta", nome: c.nome, parametros: c.parametros })}`
            : "";
          return `[${m.codigo}]${selo} ${m.titulo}\n${m.trecho}${pronto}`;
        })
        .join("\n\n")
    : "";
  const planilha = anexo ? contextoPlanilha(anexo) : null;
  const nomesPlanilha = planilha ? [...nomesDePessoas(planilha.linhasAmostra, []), ...nomesNoTexto(planilha.texto)] : [];
  mensagens.push({
    papel: "user",
    conteudo: esconder(
      `Agora são ${hora} de ${hojeLocal(agora)}.${avisoCentral ? ` ${avisoCentral}` : ""}\n` +
        (continuacao
          ? `CONTINUAÇÃO DA CONVERSA: esta pergunta segue as trocas acima${ultimaEm ? ` (a última foi em ${dataHora(ultimaEm)})` : ""}. Mantenha o MESMO recorte da última consulta (período, cliente, loja, filtros, tipo de dado) e mude só o que a pessoa mudou agora. Datas relativas ditas nas trocas anteriores ("ontem", "hoje") valem a partir da data daquela troca.\n`
          : ultimaEm
            ? `Esta conversa foi retomada (a última troca foi em ${dataHora(ultimaEm)}). Se a pergunta continuar o assunto, mantenha o recorte da última consulta e converta "ontem"/"hoje" daquelas trocas para as datas certas.\n`
            : "") +
        `Memória do Cérebro (regras e notas já guardadas que podem valer aqui):\n${textoMemoria ? embrulharDados(textoMemoria) : "(nada guardado sobre isso)"}\n` +
        (planilha ? `${embrulharDados(planilha.texto)}\n` : opcoes.anexo ? "A planilha anexada expirou: peça para enviar de novo.\n" : "") +
        (dica ? `${dica}\n` : "") +
        comContexto(`Pergunta:\n${embrulharDados(pergunta)}`),
      [...nomesNoTexto(textoMemoria), ...nomesPlanilha, ...nomesNoTexto(contextoAnterior)],
    ),
  });

  const resultados: Resultado[] = [];
  let avisouRota = false;
  const fontes: FonteDTO[] = [];
  let rascunho: RespostaAgente["rascunho"] = null;
  let tarefaCriada: RespostaAgente["tarefa"] = null;
  let reuniaoCriada: { titulo: string } | null = null;

  const observar = (texto: string, nomes: string[] = []) => mensagens.push({ papel: "user", conteudo: esconder(texto, nomes) });

  /** Guarda o resultado, registra na auditoria e mostra para a IA (com os nomes mascarados). */
  const registrarResultado = async (r: Resultado, origem: string, extra = "", nomesExtra: string[] = []) => {
    resultados.push(r);
    await auditar(ctx.pool, ator, "argos.consulta_central", undefined, { pergunta: pergunta.slice(0, 300), origem, linhas: r.linhas.length, ms: r.ms });
    const amostra = r.linhas.slice(0, LINHAS_PARA_IA);
    observar(
      `Resultado ${r.id} — ${r.titulo}: ${r.linhas.length}${r.cortado ? "+ (cortado)" : ""} linhas, ${r.ms} ms.${extra}\n` +
        (Object.keys(r.totais).length ? `Totais: ${json(r.totais)}\n` : "") +
        `Colunas: ${r.colunas.join(", ")}\n` +
        embrulharDados(json(amostra)) +
        (r.linhas.length > LINHAS_PARA_IA ? `\n(mostrando ${LINHAS_PARA_IA} de ${r.linhas.length}; agregue no SQL se precisar do todo)` : ""),
      [...nomesDePessoas(amostra, r.tabelas), ...nomesExtra],
    );
  };

  const mostrarConhecimento = (achados: Awaited<ReturnType<typeof buscar>>) => {
    for (const f of achados.slice(0, 5)) if (!fontes.some((x) => x.registroId === f.registroId)) fontes.push({ ...f, indice: fontes.length + 1 });
    observar(
      achados.length
        ? `Encontrado no Cérebro:\n${embrulharDados(achados.slice(0, 5).map((f) => `[${f.codigo}] ${f.titulo}\n${f.trecho}`).join("\n\n"))}`
        : "Nada sobre isso na base de conhecimento do Cérebro.",
    );
  };

  // "Como fazemos X?": a memória achada já é a resposta (vira fonte citada).
  if (processo) for (const f of memorias) if (!fontes.some((x) => x.registroId === f.registroId)) fontes.push({ ...f, indice: fontes.length + 1 });

  // A consulta prevista já voltou: entra na conversa como se fosse a 1ª etapa, e a IA costuma responder de primeira.
  // Uma regra vigente com cálculo próprio vale mais que a consulta genérica prevista (ex.: "margem" → faturamento).
  if (plano && preBusca && !calculos.size) {
    mensagens.push({ papel: "assistant", conteudo: json({ acao: "pronta", nome: plano.ferramenta, parametros: plano.parametros, pensamento: "consulta pronta para essa pergunta" }) });
    await registrarResultado(
      { ...preBusca, id: "r1" },
      `pronta:${plano.ferramenta}`,
      " Se isso já responde, responda agora; se a pergunta pedir outro recorte, consulte de novo.",
    );
  }

  for (let passo = 1; passo <= MAX_PASSOS; passo++) {
    const ultimo = passo === MAX_PASSOS;
    if (ultimo) observar('Limite de etapas atingido. Responda agora com {"acao":"responder", ...} usando o que já tem.');

    const t = Date.now();
    const bruto = await ia.gerar({ sistema, mensagens, json: true, temperatura: 0.1, maxTokens: 1200, raciocinio: ctx.ambiente.ARGOS_RACIOCINIO });
    tempos[`ia${passo}`] = Date.now() - t;
    mensagens.push({ papel: "assistant", conteudo: bruto });
    let p: PassoAgente;
    try {
      p = lerJson<PassoAgente>(bruto);
    } catch {
      observar('Sua resposta não era um JSON válido. Devolva só o objeto JSON da próxima ação.');
      continue;
    }
    ctx.log.info({ passo, acao: p.acao, pensamento: p.pensamento?.slice(0, 200) }, "argos: etapa");

    if (p.acao === "responder" || ultimo) {
      const final = lerJson<PassoAgente>(restaurar(bruto, mapa));
      const escolhido =
        (final.mostrar && resultados.find((r) => r.id === final.mostrar)) || [...resultados].reverse().find((r) => r.linhas.length) || resultados.at(-1) || null;
      const confirmar = final.confirmar === true;
      tempos.total = Date.now() - inicio;
      const usou = new Set((Array.isArray(final.usou) ? final.usou : []).map((c) => String(c).trim().toUpperCase()));
      const memoriasUsadas: MemoriaUsadaDTO[] = memorias
        .filter((m) => usou.has(m.codigo.toUpperCase()))
        .map((m) => ({ registroId: m.registroId, codigo: m.codigo, titulo: m.titulo, naoRevisada: m.status === "rascunho" }));
      ctx.log.info({ tempos, passos: passo }, "argos: respondeu");
      return {
        ...(() => {
          const { fala, resto } = limparFala(final.fala ?? "");
          const analise = confirmar ? null : [resto, final.analise?.trim()].filter(Boolean).join("\n\n") || null;
          return { fala: fala || "Pronto.", analise: analise ? removerMarcas(analise) : null };
        })(),
        dados: !confirmar && escolhido ? paraTela(escolhido, resultados, final, pergunta) : null,
        fontes: confirmar ? [] : fontes,
        abrir: confirmar ? null : final.abrir?.trim() || null,
        rascunho,
        tarefa: tarefaCriada,
        passos: passo,
        tempos,
        confirmar,
        memorias: memoriasUsadas,
      };
    }

    switch (p.acao) {
      case "colunas": {
        if (!catalogo.length) {
          observar(`Erro: ${avisoCentral || "sem catálogo"}`);
          break;
        }
        const pedidas = (p.tabelas ?? []).map((t) => t.replace(/^(public|argos)\./, ""));
        const existentes = pedidas.filter((t) => nomesTabelas.has(t)).slice(0, 8);
        const faltando = pedidas.filter((t) => !nomesTabelas.has(t));
        observar(
          `${existentes.length ? detalharTabelas(catalogo, existentes) : "Nenhuma dessas tabelas existe."}` +
            (faltando.length ? `\n\nNão existem: ${faltando.join(", ")}. Procure no catálogo um nome parecido.` : ""),
        );
        break;
      }

      case "pronta":
      case "sql": {
        if (!ctx.central) {
          observar(`Erro: ${avisoCentral}`);
          break;
        }
        const id = `r${resultados.length + 1}`;
        try {
          const t = Date.now();
          let r: Resultado;
          if (p.acao === "pronta") {
            // Cálculo ligado a uma regra vigente: os valores da regra valem; a IA só escolhe o período.
            const daRegra = [...calculos.values()].find((c) => c.nome === p.nome);
            const parametros = daRegra
              ? { ...(p.parametros ?? {}), ...daRegra.parametros, inicio: p.parametros?.inicio, fim: p.parametros?.fim }
              : (p.parametros ?? {});
            r = { ...(await rodarPronta(ctx, p.nome ?? "", parametros)), id };
          } else if (sugerido && !avisouRota && !resultados.some((x) => x.origem === "central")) {
            // Uma vez por pergunta: lembra a IA de que esse número tem rota na Central (o SQL dela costuma divergir da tela).
            avisouRota = true;
            observar(`Antes do SQL: esse indicador existe na rota "${sugerido.id}" da Central (${sugerido.motivo}). Use {"acao":"central","endpoint":"${sugerido.id}",...} para chegar no mesmo número da tela. Se ela não tiver o dado, aí sim escreva o SQL.`);
            break;
          } else {
            const sql = validarSql(p.sql ?? "");
            const x = await consultar(ctx.central, sql, [], { limite: 200 });
            const tabelas = [...nomesTabelas].filter((t) => new RegExp(`\\b${t}\\b`, "i").test(sql));
            r = { id, titulo: p.titulo?.trim() || "Consulta à Central", origem: "livre", sql, colunas: x.colunas, linhas: x.linhas, cortado: x.cortado, totais: {}, tabelas, ms: x.ms };
          }
          tempos[`banco${passo}`] = Date.now() - t;
          await registrarResultado(r, r.origem === "pronta" ? `pronta:${p.nome}` : "livre");
        } catch (erro) {
          const msg = (erro as Error).message.slice(0, 500);
          ctx.log.warn({ erro: msg }, "argos: consulta falhou");
          observar(`Erro na consulta: ${msg}\nConfira as colunas (acao "colunas") e tente de novo.`);
        }
        break;
      }

      case "central": {
        if (!ctx.centralApi) {
          observar("A API da Central não está ligada ao Argos (faltam CENTRAL_API_URL e CENTRAL_API_SEGREDO). Use sql ou pronta, e avise que o número é do banco.");
          break;
        }
        const id = `r${resultados.length + 1}`;
        try {
          const t = Date.now();
          const x = await ctx.centralApi.consultar(p.endpoint ?? "", p.parametros ?? {});
          tempos[`api${passo}`] = Date.now() - t;
          const { resultado, outras } = resultadoDaCentral(id, x.endpoint, x.dados, p.tabela ?? null, p.titulo, x.url, x.ms);
          await registrarResultado(
            resultado,
            `central:${x.endpoint.id}`,
            outras.length ? ` Outras tabelas nesta resposta (use "tabela" para ver): ${outras.join("; ")}.` : "",
            nomesDaCentral(x.endpoint, resultado),
          );
        } catch (erro) {
          const msg = (erro as Error).message.slice(0, 400);
          ctx.log.warn({ erro: msg, endpoint: p.endpoint }, "argos: API da Central falhou");
          observar(`Erro ao chamar a Central: ${msg}`);
        }
        break;
      }

      case "planilha": {
        if (!anexo) {
          observar(opcoes.anexo ? "A planilha anexada expirou. Peça para a pessoa enviar de novo." : "Não há planilha anexada nesta conversa.");
          break;
        }
        const id = `r${resultados.length + 1}`;
        try {
          const x = consultarPlanilha(anexo, p);
          const r: Resultado = {
            id,
            titulo: p.titulo?.trim() || `${anexo.nome} · ${x.aba}`,
            origem: "planilha",
            sql: `-- planilha "${anexo.nome}", aba "${x.aba}" (${x.total} linhas no resultado)\n${json({ filtros: p.filtros ?? [], agrupar: p.agrupar ?? [], metricas: p.metricas ?? [], ordenar: p.ordenar ?? null })}`,
            colunas: x.colunas,
            linhas: x.linhas,
            cortado: x.cortado,
            totais: {},
            tabelas: [],
            ms: x.ms,
          };
          await registrarResultado(r, "planilha", "", nomesNoTexto(json(x.linhas.slice(0, LINHAS_PARA_IA))));
        } catch (erro) {
          observar(`Erro no cálculo da planilha: ${(erro as Error).message.slice(0, 400)}`);
        }
        break;
      }

      case "conhecimento": {
        // Só conteúdo não restrito vai para a IA externa.
        mostrarConhecimento(await buscar(ctx, { pergunta: p.busca || pergunta, incluirRascunhos: false, incluirRestritos: false }));
        break;
      }

      case "pendencias": {
        const inicio = await resumoInicio(ctx);
        observar(
          json({
            para_aprovar: inicio.paraRevisar.slice(0, 8).map((r) => ({ codigo: r.codigo, titulo: r.titulo })),
            revisao_vencida: inicio.vencidos.slice(0, 8).map((r) => ({ codigo: r.codigo, titulo: r.titulo })),
          }),
        );
        break;
      }

      case "tarefas": {
        const lista = await listarTarefas(ctx, ator, { filtro: p.filtro ?? "todas" });
        observar(
          json(
            lista.slice(0, 40).map((t) => ({
              codigo: t.codigo,
              titulo: t.titulo,
              situacao: t.status,
              prazo: t.prazo,
              atrasada: t.atrasada,
              responsavel: t.responsavel?.nome ?? null,
              de: t.registros[0]?.codigo ?? null,
            })),
          ),
          lista.map((t) => t.responsavel?.nome ?? "").filter(Boolean),
        );
        break;
      }

      case "criar_tarefa": {
        // Uma tarefa por pedido: se o modelo tentar criar de novo na mesma conversa, não duplica.
        if (tarefaCriada) {
          observar(`A tarefa ${tarefaCriada.codigo} já foi criada agora. Não crie outra; responda.`);
          break;
        }
        const ligado = p.registro ? await registros.buscarPorCodigo(ctx.pool, restaurar(p.registro, mapa).trim().toUpperCase()) : null;
        const t = await criarTarefa(
          ctx,
          ator,
          {
            titulo: restaurar(p.titulo ?? "", mapa).trim().slice(0, 300) || pergunta.slice(0, 300),
            descricao: restaurar(p.descricao ?? "", mapa),
            responsavelTexto: p.responsavel ? restaurar(p.responsavel, mapa) : null,
            prazo: p.prazo && /^\d{4}-\d{2}-\d{2}$/.test(p.prazo) ? p.prazo : null,
            registros: ligado ? [ligado.id] : [],
          },
          { origem: "argos" },
        );
        tarefaCriada = { id: t.id, codigo: t.codigo };
        observar(`Tarefa ${t.codigo} criada${t.responsavel ? ` para ${t.responsavel.nome}` : ""}${t.prazo ? `, prazo ${t.prazo}` : ""}.`);
        break;
      }

      case "agendar_reuniao": {
        if (reuniaoCriada) {
          observar(`A reunião "${reuniaoCriada.titulo}" já foi marcada agora. Não marque de novo; responda.`);
          break;
        }
        try {
          const r = await criarReuniao(ctx, ator, {
            titulo: restaurar(p.titulo ?? "", mapa),
            inicio: p.inicio,
            duracaoMin: p.duracaoMin,
            descricao: restaurar(p.descricao ?? "", mapa),
            convidados: (p.convidados ?? []).map((c) => restaurar(c, mapa)),
            meet: p.meet,
          });
          reuniaoCriada = { titulo: r.titulo };
          const quando = new Date(r.inicio).toLocaleString("pt-BR", { timeZone: "America/Bahia", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
          observar(
            `Reunião "${r.titulo}" marcada no Google Agenda para ${quando}${r.meet ? ", com link do Meet" : ""}.` +
              (r.convidados.length ? ` Convite enviado para ${r.convidados.length} pessoa(s).` : "") +
              (r.semEmail.length ? ` Sem e-mail no Cérebro (não receberam convite): ${r.semEmail.join(", ")}.` : ""),
          );
        } catch (erro) {
          observar(`Não consegui marcar: ${(erro as Error).message}`);
        }
        break;
      }

      case "rascunho": {
        const tipo: TipoRegistro = p.tipo && (TIPOS_REGISTRO as readonly string[]).includes(p.tipo) && p.tipo !== "reuniao" ? (p.tipo as TipoRegistro) : "nota";
        const titulo = restaurar(p.titulo ?? "", mapa).trim().slice(0, 200) || "Anotação por voz";
        const conteudo = restaurar(p.conteudo ?? "", mapa).trim() || pergunta;
        const entrada = esquemaCriarRegistro.parse({ tipo, titulo: titulo.length >= 3 ? titulo : "Anotação por voz", conteudo, dados: { via: "voz", falaOriginal: pergunta } });
        const r = await criarRegistro(ctx, ator, entrada, { origem: "manual", sempreRascunho: true });
        rascunho = { id: r.id, codigo: r.codigo };
        observar(`Salvo como rascunho de ${NOME_TIPO[tipo].toLowerCase()} ${r.codigo}. Ele aparece em Revisar para aprovação.`);
        break;
      }

      default:
        observar(`Ação "${String(p.acao)}" não existe. Use colunas, sql, pronta, planilha, conhecimento, pendencias, tarefas, criar_tarefa, agendar_reuniao, rascunho ou responder.`);
    }
  }
  return { fala: "Não consegui concluir agora. Tente perguntar de outro jeito.", analise: null, dados: null, fontes, abrir: null, rascunho, tarefa: tarefaCriada, passos: MAX_PASSOS, tempos: { ...tempos, total: Date.now() - inicio }, confirmar: false, memorias: [] };
}

/**
 * Prováveis nomes próprios num texto livre ("Antônio Carlos Jansem", "Marcos Gabriel"):
 * duas a cinco palavras com inicial maiúscula. Lojas e empresas também entram — mascarar a mais é inofensivo,
 * o marcador volta a ser o nome na resposta.
 */
/**
 * Transforma a resposta de um endpoint da Central num resultado do Argos: os números soltos
 * viram totais e uma das listas vira a tabela (a pedida, a padrão do endpoint ou a maior).
 */
export function resultadoDaCentral(
  id: string,
  e: EndpointCentral,
  dados: unknown,
  tabela: string | null,
  titulo: string | undefined,
  url: string,
  ms: number,
): { resultado: Resultado; outras: string[] } {
  const { numeros, tabelas } = lerRespostaCentral(dados);
  const fim = (c: string) => c.split(".").at(-1)!.toLowerCase();
  const pedida = tabela ? tabelas.find((t) => t.caminho.toLowerCase() === tabela.toLowerCase() || fim(t.caminho) === tabela.toLowerCase()) : undefined;
  const escolhida =
    pedida ??
    (e.tabelaPadrao ? tabelas.find((t) => fim(t.caminho) === e.tabelaPadrao!.toLowerCase()) : undefined) ??
    [...tabelas].sort((a, b) => b.linhas.length - a.linhas.length)[0];
  const linhas = escolhida?.linhas.slice(0, 200) ?? [];
  const colunas = [...new Set(linhas.slice(0, 50).flatMap((l) => Object.keys(l)))];
  const totais: Resultado["totais"] = {};
  for (const [k, v] of Object.entries(numeros).slice(0, 40)) totais[k] = typeof v === "boolean" ? String(v) : (v as number | string | null);
  return {
    resultado: {
      id,
      titulo: titulo?.trim() || `${e.descricao.split(/[:.(]/)[0]}${escolhida ? ` · ${escolhida.caminho}` : ""}`.slice(0, 120),
      origem: "central",
      sql: `-- API da Central (mesmo cálculo da tela): GET ${url}${escolhida ? `\n-- tabela: ${escolhida.caminho}` : ""}`,
      colunas,
      linhas,
      cortado: (escolhida?.linhas.length ?? 0) > 200,
      totais,
      tabelas: [],
      ms,
    },
    outras: tabelas.filter((t) => t !== escolhida).map((t) => `${t.caminho} (${t.linhas.length})`).slice(0, 10),
  };
}

// Marcas que só existem no histórico (resumo das tabelas): nunca podem aparecer na resposta.
const MARCA = /\n?\[(Tabela mostrada|Recorte usado|Totais)[^\]]*\][\s\S]*$/;

/** Separa a fala de uma resposta anterior do resumo do que ela mostrou. */
export function separarContexto(resposta: string): { fala: string; contexto: string } {
  const i = resposta.search(/\n?\[(Tabela mostrada|Recorte usado|Totais)/);
  return i < 0 ? { fala: resposta.trim(), contexto: "" } : { fala: resposta.slice(0, i).trim(), contexto: resposta.slice(i).trim() };
}

const removerMarcas = (t: string) => t.replace(MARCA, "").trim();

/**
 * A fala é lida em voz alta: sem as marcas do histórico e curta (até ~3 frases).
 * O que passar disso não some: vai para a análise escrita.
 */
export function limparFala(bruta: string, limite = 380): { fala: string; resto: string } {
  const t = removerMarcas(bruta).replace(/\s+/g, " ").trim();
  if (t.length <= limite) return { fala: t, resto: "" };
  const frases = t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [t];
  let fala = "";
  let i = 0;
  while (i < frases.length && (fala + frases[i]).length <= limite) fala += frases[i++];
  if (!fala) {
    const corte = t.lastIndexOf(" ", limite);
    return { fala: `${t.slice(0, corte > 0 ? corte : limite).trim()}…`, resto: t };
  }
  return { fala: fala.trim(), resto: frases.slice(i).join("").trim() };
}

/** Pergunta de indicador que tem rota pronta na Central. */
export function endpointProvavel(pergunta: string): { id: string; motivo: string } | null {
  const t = pergunta.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const semanal = /semana|semanal|semanas/.test(t);
  if (/ticket/.test(t) || (semanal && /entrega|prazo|cliente|volume|caiu|subiu|compar/.test(t)))
    return semanal || /caiu|subiu|compar|evolu|queda/.test(t)
      ? { id: "bi.comparativo_semanal_clientes", motivo: "comparativo semanal por cliente: entregas, ticket e variação, como a tela" }
      : { id: "bi.dashboard", motivo: "painel do BI: ticket médio, entregas e prazo do período" };
  if (/garantido/.test(t)) return { id: "bi.garantido", motivo: "garantido dos motoboys" };
  if (/taxa de prazo|no prazo|fora do prazo|sla|retorno|tempo medio/.test(t)) return { id: "bi.dashboard", motivo: "painel do BI: prazo, retornos e tempos" };
  if (/(faturamento|receita|repasse|bi financeiro|margem bruta)/.test(t) && !/motoboy/.test(t)) return { id: "fin.painel", motivo: "painel do BI Financeiro" };
  return null;
}

// Listas de pessoas nas respostas da Central: até a coluna "nome" é de pessoa.
const LISTA_DE_PESSOA = /(prof|motoboy|garantido|saque|withdraw|escala|comiss|vendedor|sinistro|gratuid|isenc|taxa_fixa)/i;

function nomesDaCentral(e: EndpointCentral, r: Resultado): string[] {
  const dePessoa = LISTA_DE_PESSOA.test(`${e.id} ${r.sql}`);
  const nomes = new Set(nomesDePessoas(r.linhas.slice(0, LINHAS_PARA_IA), []));
  if (dePessoa)
    for (const l of r.linhas.slice(0, LINHAS_PARA_IA))
      for (const [col, v] of Object.entries(l)) if (typeof v === "string" && /(^|_)nome($|_)/i.test(col) && !/cliente|fantasia|loja|centro|regiao|cidade/i.test(col)) nomes.add(v);
  return [...nomes];
}

export function nomesNoTexto(texto: string): string[] {
  // Só espaços na mesma linha: nome de uma linha não emenda com a palavra da linha de cima.
  const achados = texto.match(/(?<![\p{L}\p{N}])\p{Lu}\p{Ll}+(?:[ \t]+(?:d[aeo]s?[ \t]+)?\p{Lu}\p{Ll}+){1,4}(?![\p{L}\p{N}])/gu) ?? [];
  return [...new Set(achados)].filter((n) => n.length >= 5).slice(0, 80);
}

/** Valores de colunas de pessoa, para a máscara. */
function nomesDePessoas(linhas: Record<string, unknown>[], tabelas: string[]): string[] {
  const deTabelaDePessoa = tabelas.some((t) => TABELA_DE_PESSOA.test(t));
  const nomes = new Set<string>();
  for (const l of linhas)
    for (const [col, v] of Object.entries(l))
      if (typeof v === "string" && (COLUNA_DE_PESSOA.test(col) || (deTabelaDePessoa && /^nome$/i.test(col)))) nomes.add(v);
  return [...nomes];
}

function paraTela(r: Resultado, todos: Resultado[], final: PassoAgente, pergunta: string): DadosCentralDTO {
  const outras = todos.filter((x) => x !== r);
  return {
    titulo: r.titulo,
    origem: r.origem,
    colunas: r.colunas,
    linhas: r.linhas.slice(0, LINHAS_PARA_TELA),
    cortado: r.cortado || r.linhas.length > LINHAS_PARA_TELA,
    totais: r.totais,
    destaques: (final.destaques ?? []).filter((d) => d?.rotulo && d?.valor).slice(0, 4).map((d) => ({ rotulo: String(d.rotulo), valor: String(d.valor) })),
    analise: final.analise?.trim() || null,
    sql: [r.sql, ...outras.map((o) => `-- ${o.titulo}\n${o.sql}`)].join("\n\n"),
    explicacao: todos.length > 1 ? `${todos.length} consultas para chegar na resposta.` : null,
    tabelas: [...new Set(todos.flatMap((x) => x.tabelas))],
    ms: todos.reduce((s, x) => s + x.ms, 0),
    grafico: lerGrafico(final.grafico, r, pergunta),
  };
}

const PEDIU_GRAFICO = /gr[aá]fico|grafic|barras?|pizza|linha do tempo|evolu[cç][aã]o|tend[eê]ncia|compar/i;

const ehNumero = (v: unknown) => v === null || typeof v === "number" || typeof v === "bigint" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v));

/**
 * O gráfico que a IA sugeriu, conferido contra o resultado: só colunas que existem,
 * só números no eixo dos valores. Os valores desenhados são sempre as linhas da consulta.
 */
export function lerGrafico(g: PassoAgente["grafico"], r: Pick<Resultado, "colunas" | "linhas">, pergunta: string): GraficoDTO | null {
  if (!g || typeof g !== "object" || !r.linhas.length) return null;
  const tipo = g.tipo === "linha" || g.tipo === "barras" || g.tipo === "pizza" ? g.tipo : null;
  if (!tipo || !g.x || !r.colunas.includes(g.x)) return null;
  const amostra = r.linhas.slice(0, 20);
  const pedidos = (Array.isArray(g.y) ? g.y : g.y ? [g.y] : []).filter((c): c is string => typeof c === "string");
  const y = [...new Set(pedidos)].filter((c) => c !== g.x && r.colunas.includes(c) && amostra.every((l) => ehNumero(l[c]))).slice(0, tipo === "pizza" ? 1 : 3);
  if (!y.length) return null;
  if (tipo === "pizza" && r.linhas.length > 12) return null;
  return { tipo, x: g.x, y, titulo: typeof g.titulo === "string" && g.titulo.trim() ? g.titulo.trim().slice(0, 120) : null, principal: PEDIU_GRAFICO.test(pergunta) };
}
