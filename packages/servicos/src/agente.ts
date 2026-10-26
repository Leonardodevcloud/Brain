import {
  CONSULTAS_PRONTAS,
  REGRAS_NEGOCIO,
  carregarCatalogo,
  consultaPronta,
  consultar,
  detalharTabelas,
  resumoDoCatalogo,
  validarSql,
  type TabelaCatalogo,
} from "@cerebro/central";
import { NOME_TIPO, TIPOS_REGISTRO, esquemaCriarRegistro, type DadosCentralDTO, type FonteDTO, type TipoRegistro } from "@cerebro/core";
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

/** Uma troca anterior da conversa, para o Argos entender "e em Salvador?". */
export interface TurnoAnterior {
  pergunta: string;
  resposta: string;
}

export interface RespostaAgente {
  fala: string;
  analise: string | null;
  dados: DadosCentralDTO | null;
  fontes: FonteDTO[];
  abrir: string | null;
  rascunho: { id: string; codigo: string } | null;
  tarefa: { id: string; codigo: string } | null;
  passos: number;
  /** A fala é uma pergunta de volta: a interface já fica ouvindo a resposta. */
  confirmar: boolean;
}

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
  origem: "pronta" | "livre";
  sql: string;
  colunas: string[];
  linhas: Record<string, unknown>[];
  cortado: boolean;
  totais: DadosCentralDTO["totais"];
  tabelas: string[];
  ms: number;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

/** Agente do Argos: entende a pergunta, consulta o que precisar (em etapas) e responde. */
export async function agenteArgos(ctx: Contexto, ator: Ator, pergunta: string, historico: TurnoAnterior[] = []): Promise<RespostaAgente> {
  const ia = ctx.ia!;
  const usuario = ator.usuarioId ? await usuarios.buscarPorId(ctx.pool, ator.usuarioId).catch(() => null) : null;
  const pessoa = usuario?.nome?.trim() || "um gestor da Central";

  let catalogo: TabelaCatalogo[] = [];
  let avisoCentral = "";
  if (ctx.central) {
    try {
      catalogo = await carregarCatalogo(ctx.central);
    } catch (erro) {
      avisoCentral = "O banco da Central está fora do ar agora.";
      ctx.log.warn({ erro: (erro as Error).message }, "catálogo da Central indisponível");
    }
  } else {
    avisoCentral = "O banco da Central ainda não está ligado ao Argos (falta a ARGOS_DB_SENHA). Diga isso se a pergunta precisar de dados.";
  }
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
    });

  // Uma única máscara para a conversa inteira: o mesmo nome vira sempre o mesmo marcador.
  const mapa = new Map<string, string>();
  const esconder = (texto: string, nomes: string[] = []) => mascarar(texto, { nomes, mapaAnterior: mapa }).texto;

  const mensagens: Mensagem[] = [];
  for (const t of historico.slice(-4)) {
    mensagens.push({ papel: "user", conteudo: esconder(`Pergunta:\n${embrulharDados(t.pergunta)}`) });
    mensagens.push({ papel: "assistant", conteudo: esconder(json({ acao: "responder", fala: t.resposta })) });
  }
  const hora = agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
  mensagens.push({
    papel: "user",
    conteudo: esconder(`Agora são ${hora} de ${hojeLocal(agora)}.${avisoCentral ? ` ${avisoCentral}` : ""}\nPergunta:\n${embrulharDados(pergunta)}`),
  });

  const resultados: Resultado[] = [];
  const fontes: FonteDTO[] = [];
  let rascunho: RespostaAgente["rascunho"] = null;
  let tarefaCriada: RespostaAgente["tarefa"] = null;
  let reuniaoCriada: { titulo: string } | null = null;

  const observar = (texto: string, nomes: string[] = []) => mensagens.push({ papel: "user", conteudo: esconder(texto, nomes) });

  for (let passo = 1; passo <= MAX_PASSOS; passo++) {
    const ultimo = passo === MAX_PASSOS;
    if (ultimo) observar('Limite de etapas atingido. Responda agora com {"acao":"responder", ...} usando o que já tem.');

    const bruto = await ia.gerar({ sistema, mensagens, json: true, temperatura: 0.1, maxTokens: 1800 });
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
      return {
        fala: (final.fala ?? "").trim() || "Pronto.",
        analise: confirmar ? null : final.analise?.trim() || null,
        dados: !confirmar && escolhido ? paraTela(escolhido, resultados, final) : null,
        fontes: confirmar ? [] : fontes,
        abrir: confirmar ? null : final.abrir?.trim() || null,
        rascunho,
        tarefa: tarefaCriada,
        passos: passo,
        confirmar,
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
          let r: Resultado;
          if (p.acao === "pronta") {
            const pronta = consultaPronta(p.nome ?? "");
            if (!pronta) throw new Error(`Consulta pronta "${p.nome}" não existe. Use: ${CONSULTAS_PRONTAS.map((c) => c.nome).join(", ")}.`);
            const x = await pronta.executar(ctx.central, p.parametros ?? {});
            r = { id, titulo: x.titulo, origem: "pronta", sql: x.sql, colunas: x.colunas, linhas: x.linhas, cortado: x.cortado, totais: x.totais, tabelas: [], ms: x.ms };
          } else {
            const sql = validarSql(p.sql ?? "");
            const x = await consultar(ctx.central, sql, [], { limite: 200 });
            const tabelas = [...nomesTabelas].filter((t) => new RegExp(`\\b${t}\\b`, "i").test(sql));
            r = { id, titulo: p.titulo?.trim() || "Consulta à Central", origem: "livre", sql, colunas: x.colunas, linhas: x.linhas, cortado: x.cortado, totais: {}, tabelas, ms: x.ms };
          }
          resultados.push(r);
          await auditar(ctx.pool, ator, "argos.consulta_central", undefined, {
            pergunta: pergunta.slice(0, 300),
            origem: r.origem === "pronta" ? `pronta:${p.nome}` : "livre",
            linhas: r.linhas.length,
            ms: r.ms,
          });
          const amostra = r.linhas.slice(0, LINHAS_PARA_IA);
          observar(
            `Resultado ${id} — ${r.titulo}: ${r.linhas.length}${r.cortado ? "+ (cortado)" : ""} linhas, ${r.ms} ms.\n` +
              (Object.keys(r.totais).length ? `Totais: ${json(r.totais)}\n` : "") +
              `Colunas: ${r.colunas.join(", ")}\n` +
              embrulharDados(json(amostra)) +
              (r.linhas.length > LINHAS_PARA_IA ? `\n(mostrando ${LINHAS_PARA_IA} de ${r.linhas.length}; agregue no SQL se precisar do todo)` : ""),
            nomesDePessoas(amostra, r.tabelas),
          );
        } catch (erro) {
          const msg = (erro as Error).message.slice(0, 500);
          ctx.log.warn({ erro: msg }, "argos: consulta falhou");
          observar(`Erro na consulta: ${msg}\nConfira as colunas (acao "colunas") e tente de novo.`);
        }
        break;
      }

      case "conhecimento": {
        // Só conteúdo não restrito vai para a IA externa.
        const achados = await buscar(ctx, { pergunta: p.busca || pergunta, incluirRascunhos: false, incluirRestritos: false });
        for (const f of achados.slice(0, 5)) if (!fontes.some((x) => x.registroId === f.registroId)) fontes.push({ ...f, indice: fontes.length + 1 });
        observar(
          achados.length
            ? `Encontrado no Cérebro:\n${embrulharDados(achados.slice(0, 5).map((f) => `[${f.codigo}] ${f.titulo}\n${f.trecho}`).join("\n\n"))}`
            : "Nada sobre isso na base de conhecimento do Cérebro.",
        );
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
        observar(`Ação "${String(p.acao)}" não existe. Use colunas, sql, pronta, conhecimento, pendencias, tarefas, criar_tarefa, agendar_reuniao, rascunho ou responder.`);
    }
  }
  return { fala: "Não consegui concluir agora. Tente perguntar de outro jeito.", analise: null, dados: null, fontes, abrir: null, rascunho, tarefa: tarefaCriada, passos: MAX_PASSOS, confirmar: false };
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

function paraTela(r: Resultado, todos: Resultado[], final: PassoAgente): DadosCentralDTO {
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
  };
}
