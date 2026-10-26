import { AppError, NOME_TIPO, TIPOS_REGISTRO, esquemaCriarRegistro, type RespostaAssistenteDTO, type TipoRegistro } from "@cerebro/core";
import { integracoes, registros, usuarios } from "@cerebro/db";
import {
  SISTEMA_ASSISTENTE,
  lerJson,
  mascarar,
  montarPedidoAssistente,
  restaurar,
  VOZES_FALA,
  textoParaFala,
  type IntencaoAssistente,
} from "@cerebro/ia";
import { agenteArgos, type TurnoAnterior } from "./agente.js";
import { buscar, responder } from "./busca.js";
import { consultarCentral, planoRapido } from "./central.js";
import { auditar, type Ator, type Contexto } from "./contexto.js";
import { resumoInicio } from "./painel.js";
import { criarRegistro } from "./registros.js";

export const LIMITE_AUDIO_BYTES = 8 * 1024 * 1024;

const TELAS: Record<string, { destino: string; rotulo: string }> = {
  inicio: { destino: "/", rotulo: "Início" },
  perguntar: { destino: "/perguntar", rotulo: "Perguntar" },
  biblioteca: { destino: "/biblioteca", rotulo: "Biblioteca" },
  tarefas: { destino: "/tarefas", rotulo: "Tarefas" },
  agenda: { destino: "/agenda", rotulo: "Agenda" },
  email: { destino: "/email", rotulo: "E-mail" },
  mapa: { destino: "/mapa", rotulo: "Mapa" },
  revisar: { destino: "/revisar", rotulo: "Revisar" },
  integracoes: { destino: "/integracoes", rotulo: "Integrações" },
  conta: { destino: "/conta", rotulo: "Sua conta" },
};

const sem = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const NOMES_TELA: [RegExp, string][] = [
  [/\bmapas?\b/, "mapa"],
  [/\bbiblioteca\b/, "biblioteca"],
  [/\b(tarefas?|afazeres|to ?do)\b/, "tarefas"],
  [/\b(agenda|calendario|compromissos?|reunioes)\b/, "agenda"],
  [/\b(e-?mails?|caixa de entrada|inbox)\b/, "email"],
  [/\b(revisar|revisao|revisoes|aprovacao|aprovacoes)\b/, "revisar"],
  [/\bintegrac(ao|oes)\b/, "integracoes"],
  [/\b(minha conta|conta|perfil|senha)\b/, "conta"],
  [/\b(inicio|home|tela inicial|pagina inicial|painel)\b/, "inicio"],
  [/\b(perguntar|perguntas)\b/, "perguntar"],
];
const VERBO_IR = /\b(abr\w*|mostr\w*|exib\w*|vai|va|vamos|ir|leva\w*|entr\w*|naveg\w*|quero ver|me (leva|mostra)|coloca|bota|volta\w*)\b/;

/** Comandos óbvios não precisam da IA: respondem na hora e funcionam mesmo sem DeepSeek. */
export function interpretarRapido(fala: string): IntencaoAssistente | null {
  const t = sem(fala).replace(/[^a-z0-9 -]/g, " ").replace(/\s+/g, " ").trim().replace(/^(ei |oi |ola |e ai )?argos\s+/, "");
  const vazio = { alvo: null, tipo: null, titulo: null, conteudo: null, fala: null };
  const palavras = t.split(" ").filter(Boolean).length;

  // "abre o mapa", "pode abrir o mapa pra mim?", "me leva pra biblioteca", "volta pro início".
  if (palavras <= 12 && VERBO_IR.test(t)) {
    const codigo = /\b([a-z]{2,4})[ -]?(\d{1,4})\b/.exec(t);
    if (codigo && /\b(pop|pol|dec|ata|cli|not|ref)\b/.test(codigo[1]!)) {
      const alvo = `${codigo[1]}-${codigo[2]}`;
      return { intencao: /\bmapa\b/.test(t) ? "mapa" : "abrir", ...vazio, alvo };
    }
    const tela = NOMES_TELA.find(([re]) => re.test(t));
    if (tela) return { intencao: "navegar", ...vazio, alvo: tela[1] };
  }
  if (/(o que|tem (algo|alguma coisa)|quais|quantos?|alguma coisa).*(revisar|aprovar|pendent|pendencia|vencid)/.test(t)) {
    return { intencao: "pendencias", ...vazio };
  }
  if (planoRapido(t) && !/\b(como (funciona|fazer|tratamos|trata|e o processo)|qual (o|a) (regra|politica|procedimento|processo)|pop)\b/.test(t)) {
    return { intencao: "dados", ...vazio };
  }
  if (ehConversa(t)) return { intencao: "conversa", ...vazio, fala: null };
  return null;
}

const CUMPRIMENTO = /^(oi|ola|opa|e ai|eai|hey|fala|bom dia|boa tarde|boa noite|salve)\b/;
const PAPO = /\b(tudo (bem|bom|certo|tranquilo|joia|beleza)|como (vai|voce (esta|ta)|esta voce|ce ta)|beleza|blz|obrigad[oa]|valeu|brigad[oa]|quem e voce|o que voce (faz|sabe fazer|pode fazer)|voce me ouve|ta me ouvindo|teste|testando)\b/;
/** Cumprimento ou papo curto, sem assunto da operação no meio. */
function ehConversa(t: string) {
  const palavras = t.split(" ").filter(Boolean);
  if (palavras.length > 9) return false;
  const resto = t.replace(CUMPRIMENTO, "").replace(PAPO, "").replace(/\b(argos|ai|ae|e|ce|voce|cara|meu|amigo|mano|por|ai)\b/g, "").trim();
  return (CUMPRIMENTO.test(t) || PAPO.test(t)) && resto.split(" ").filter(Boolean).length <= 2;
}

/** Resposta de conversa sem IA: cumprimenta pelo nome e oferece ajuda. */
function respostaConversa(t: string, saudar: string, nome: string | null) {
  const quem = nome ? `, ${nome}` : "";
  if (/obrigad|valeu|brigad/.test(t)) return `Por nada${quem}! Se precisar, é só chamar.`;
  if (/quem e voce|o que voce/.test(t))
    return `Sou o Argos, o assistente do Cérebro da Central Tutts. Respondo sobre processos e decisões, trago números da operação, como disponibilidade, entregas, faturamento e saques, abro registros e anoto ideias como rascunho.`;
  if (/me ouve|me ouvindo|teste|testando/.test(t)) return `Estou te ouvindo bem${quem}. Pode perguntar.`;
  const bem = /tudo (bem|bom|certo|tranquilo|joia|beleza)|como (vai|voce|esta|ce)|beleza|blz/.test(t) ? " Tudo certo por aqui, e com você?" : "";
  return `${saudar}${quem}!${bem} Posso te dizer como está a disponibilidade, as entregas de hoje, o faturamento ou os saques, ou responder sobre algum processo.`;
}

function saudacao(agora: Date) {
  const h = Number(agora.toLocaleTimeString("en-GB", { hour: "2-digit", timeZone: "America/Bahia" }).slice(0, 2));
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

async function classificar(ctx: Contexto, fala: string): Promise<IntencaoAssistente> {
  const rapido = interpretarRapido(fala);
  if (rapido) return rapido;
  // Sem IA, tudo vira pergunta: a busca ainda encontra os registros.
  if (!ctx.ia) return { intencao: "perguntar", alvo: null, tipo: null, titulo: null, conteudo: null, fala: null };

  const { texto, mapa } = mascarar(fala);
  try {
    const bruto = await ctx.ia.gerar({
      sistema: SISTEMA_ASSISTENTE,
      mensagens: [{ papel: "user", conteudo: montarPedidoAssistente(texto) }],
      json: true,
      temperatura: 0,
      maxTokens: 600,
    });
    const r = lerJson<IntencaoAssistente>(restaurar(bruto, mapa));
    const validas = ["perguntar", "dados", "pendencias", "abrir", "mapa", "navegar", "rascunho", "conversa"];
    return validas.includes(r.intencao) ? r : { ...r, intencao: "perguntar" };
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "falha ao classificar a fala; tratando como pergunta");
    return { intencao: "perguntar", alvo: null, tipo: null, titulo: null, conteudo: null, fala: null };
  }
}

/** Primeiro registro que casa com o assunto falado (código exato tem prioridade). */
async function acharRegistro(ctx: Contexto, alvo: string) {
  const codigo = alvo.toUpperCase().replace(/\s+/g, "").match(/^([A-Z]{2,4})-?(\d{1,4})$/);
  if (codigo) {
    const r = await registros.buscarPorCodigo(ctx.pool, `${codigo[1]}-${codigo[2]!.padStart(3, "0")}`);
    if (r) return { id: r.id, codigo: r.codigo, titulo: r.titulo };
  }
  const [melhor] = await buscar(ctx, { pergunta: alvo, incluirRascunhos: true });
  return melhor ? { id: melhor.registroId, codigo: melhor.codigo, titulo: melhor.titulo } : null;
}

/** Recebe o que a pessoa falou, decide o que fazer, faz e devolve o que dizer. */
export async function atenderFala(ctx: Contexto, ator: Ator, falaBruta: string, historico: TurnoAnterior[] = []): Promise<RespostaAssistenteDTO> {
  const fala = falaBruta.trim().slice(0, 1000);
  if (fala.length < 2) throw AppError.requisicaoInvalida("Não ouvi nada. Segure o espaço e fale de novo.");

  // Com IA ligada, o agente entende qualquer jeito de perguntar e busca o que precisar.
  // Só os comandos de tela óbvios ("abre o mapa") ficam no atalho, por serem instantâneos.
  const rapido = interpretarRapido(fala);
  if (ctx.ia && rapido?.intencao !== "navegar") {
    try {
      return await viaAgente(ctx, ator, fala, historico);
    } catch (erro) {
      ctx.log.warn({ erro: (erro as Error).message }, "agente do Argos falhou; usando as regras simples");
    }
  }

  const i = await classificar(ctx, fala);
  const base = { texto: fala, intencao: i.intencao, detalhe: null, fontes: [], acao: null } satisfies Partial<RespostaAssistenteDTO>;
  let resultado: RespostaAssistenteDTO;

  switch (i.intencao) {
    case "navegar": {
      const tela = TELAS[i.alvo ?? ""] ?? TELAS.inicio!;
      resultado = { ...base, fala: `Abrindo ${tela.rotulo}.`, acao: { ...tela, automatica: true } };
      break;
    }

    case "dados": {
      if (!ctx.central) {
        resultado = { ...base, fala: "Ainda não estou ligado ao banco da Central. Peça ao administrador para definir a ARGOS_DB_SENHA." };
        break;
      }
      try {
        const { fala: f, dados } = await consultarCentral(ctx, ator, fala);
        resultado = { ...base, fala: f, dados };
      } catch (erro) {
        if (!(erro instanceof AppError)) throw erro;
        resultado = { ...base, fala: erro.message };
      }
      break;
    }

    case "pendencias": {
      const inicio = await resumoInicio(ctx);
      const rascunhos = inicio.paraRevisar.length;
      const vencidos = inicio.vencidos.length;
      const partes: string[] = [];
      if (rascunhos) partes.push(`${rascunhos} ${rascunhos === 1 ? "item para aprovar" : "itens para aprovar"}`);
      if (vencidos) partes.push(`${vencidos} ${vencidos === 1 ? "registro precisando de atenção" : "registros precisando de atenção"}`);
      const primeiro = inicio.paraRevisar[0];
      resultado = {
        ...base,
        fala: partes.length
          ? `Você tem ${partes.join(" e ")}.${primeiro ? ` O mais recente é ${primeiro.titulo}.` : ""}`
          : "Está tudo em dia. Nada esperando aprovação.",
        acao: partes.length ? { destino: "/revisar", rotulo: "Abrir Revisar", automatica: false } : null,
      };
      break;
    }

    case "abrir": {
      const r = await acharRegistro(ctx, i.alvo ?? fala);
      resultado = r
        ? { ...base, fala: `Abrindo ${r.codigo}, ${r.titulo}.`, acao: { destino: `/registros/${r.codigo}`, rotulo: `Abrir ${r.codigo}`, automatica: true } }
        : { ...base, fala: `Não encontrei nada sobre ${i.alvo ?? "isso"} na biblioteca.` };
      break;
    }

    case "mapa": {
      const r = i.alvo ? await acharRegistro(ctx, i.alvo) : null;
      resultado = r
        ? { ...base, fala: `Mostrando ${r.titulo} no mapa.`, acao: { destino: `/mapa?foco=${r.id}`, rotulo: "Ver no mapa", automatica: true } }
        : { ...base, fala: "Abrindo o mapa.", acao: { destino: "/mapa", rotulo: "Abrir o mapa", automatica: true } };
      break;
    }

    case "rascunho": {
      const tipo: TipoRegistro =
        i.tipo && (TIPOS_REGISTRO as readonly string[]).includes(i.tipo) && i.tipo !== "reuniao" ? (i.tipo as TipoRegistro) : "nota";
      const titulo = (i.titulo ?? fala).trim().slice(0, 200);
      const entrada = esquemaCriarRegistro.parse({
        tipo,
        titulo: titulo.length >= 3 ? titulo : "Anotação por voz",
        conteudo: (i.conteudo ?? fala).trim() || fala,
        dados: { via: "voz", falaOriginal: fala },
      });
      const r = await criarRegistro(ctx, ator, entrada, { origem: "manual", sempreRascunho: true });
      resultado = {
        ...base,
        fala: `Salvei como rascunho de ${NOME_TIPO[tipo].toLowerCase()}: ${r.titulo}. Ele aparece em Revisar para aprovação.`,
        acao: { destino: `/revisar/${r.id}`, rotulo: `Revisar ${r.codigo}`, automatica: false },
      };
      break;
    }

    case "conversa": {
      const usuario = ator.usuarioId ? await usuarios.buscarPorId(ctx.pool, ator.usuarioId).catch(() => null) : null;
      const nome = usuario?.nome?.trim().split(/\s+/)[0] ?? null;
      const t = sem(fala).replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
      resultado = { ...base, fala: i.fala?.trim() || respostaConversa(t, saudacao(ctx.agora()), nome) };
      break;
    }

    default: {
      const r = await responder(ctx, ator, { pergunta: fala, incluirRascunhos: false });
      let falaResposta: string;
      if (r.resposta) falaResposta = textoParaFala(r.resposta);
      else if (r.lacuna) falaResposta = "Ainda não tenho isso registrado. Anotei como lacuna para alguém documentar.";
      else if (r.fontes[0])
        falaResposta = `Encontrei ${r.fontes.length} ${r.fontes.length === 1 ? "registro" : "registros"} sobre isso. O principal é ${r.fontes[0].titulo}.`;
      else falaResposta = "Não encontrei nada sobre isso.";
      resultado = {
        ...base,
        intencao: "perguntar",
        fala: falaResposta,
        detalhe: r.resposta,
        fontes: r.fontes,
        acao: r.fontes[0] ? { destino: `/registros/${r.fontes[0].codigo}`, rotulo: `Abrir ${r.fontes[0].codigo}`, automatica: false } : null,
      };
    }
  }

  await auditar(ctx.pool, ator, "assistente.comando", undefined, { intencao: resultado.intencao, fala: fala.slice(0, 300) });
  return resultado;
}

/** Resposta do agente no formato da interface: fala, números, fontes e para onde ir. */
async function viaAgente(ctx: Contexto, ator: Ator, fala: string, historico: TurnoAnterior[]): Promise<RespostaAssistenteDTO> {
  const r = await agenteArgos(ctx, ator, fala, historico);
  let acao: RespostaAssistenteDTO["acao"] = null;
  if (r.abrir) {
    const [tipo, alvo] = r.abrir.includes(":") ? (r.abrir.split(":", 2) as [string, string]) : [null, r.abrir];
    const tela = !tipo ? TELAS[sem(alvo).replace("revisao", "revisar")] : undefined;
    if (tela) acao = { ...tela, automatica: true };
    else if (/^TAR-\d+$/i.test(alvo)) acao = { destino: `/tarefas?abrir=${alvo.toUpperCase()}`, rotulo: `Abrir ${alvo.toUpperCase()}`, automatica: true };
    else {
      const reg = await acharRegistro(ctx, alvo);
      if (reg) {
        acao =
          tipo === "mapa"
            ? { destino: `/mapa?foco=${reg.id}`, rotulo: "Ver no mapa", automatica: true }
            : { destino: `/registros/${reg.codigo}`, rotulo: `Abrir ${reg.codigo}`, automatica: true };
      }
    }
  }
  if (!acao && r.tarefa) acao = { destino: `/tarefas?abrir=${r.tarefa.codigo}`, rotulo: `Abrir ${r.tarefa.codigo}`, automatica: false };
  if (!acao && r.rascunho) acao = { destino: `/revisar/${r.rascunho.id}`, rotulo: `Revisar ${r.rascunho.codigo}`, automatica: false };
  if (!acao && r.fontes[0] && !r.dados) acao = { destino: `/registros/${r.fontes[0].codigo}`, rotulo: `Abrir ${r.fontes[0].codigo}`, automatica: false };

  const intencao: RespostaAssistenteDTO["intencao"] = r.dados
    ? "dados"
    : r.rascunho
      ? "rascunho"
      : acao?.automatica
        ? acao.destino.startsWith("/registros/")
          ? "abrir"
          : acao.destino.startsWith("/mapa")
            ? "mapa"
            : "navegar"
        : r.fontes.length
          ? "perguntar"
          : "conversa";
  await auditar(ctx.pool, ator, "assistente.comando", undefined, { intencao, fala: fala.slice(0, 300), passos: r.passos });
  return {
    texto: fala,
    intencao,
    fala: r.fala,
    detalhe: r.dados ? null : r.analise,
    fontes: r.dados ? [] : r.fontes,
    acao,
    dados: r.dados,
  };
}

export async function transcreverFala(ctx: Contexto, audio: Uint8Array, mime: string) {
  if (!ctx.voz) throw AppError.indisponivel("A voz ainda não está ligada. Defina GROQ_CHAVE no Railway; enquanto isso, digite para o Argos.");
  if (audio.byteLength < 1200) throw AppError.requisicaoInvalida("O áudio ficou curto demais. Segure o espaço enquanto fala.");
  if (audio.byteLength > LIMITE_AUDIO_BYTES) throw AppError.requisicaoInvalida("O áudio ficou longo demais. Fale em trechos de até 1 minuto.");
  try {
    return (await ctx.voz.transcrever(audio, mime)).trim();
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "falha na transcrição");
    throw AppError.indisponivel("Não consegui entender o áudio agora. Tente de novo.");
  }
}

// ───────────────────────────── Voz do Argos gerada no servidor ─────────────────────────────

export interface ConfigVoz {
  /** Há voz no servidor (OPENAI_CHAVE)? Sem ela, a interface usa a voz do navegador. */
  disponivel: boolean;
  voz: string;
  velocidade: number;
  vozes: readonly string[];
}

const VOZ_PADRAO = { voz: "marin", velocidade: 1.12 };
const cacheFala = new Map<string, Uint8Array>();

/** A voz escolhida vale para todo mundo, em qualquer aparelho. */
export async function configVoz(ctx: Contexto): Promise<ConfigVoz> {
  const salvo = await integracoes.obter(ctx.pool, "argos_voz");
  const voz = typeof salvo?.config.voz === "string" && (VOZES_FALA as readonly string[]).includes(salvo.config.voz) ? salvo.config.voz : VOZ_PADRAO.voz;
  const velocidade = typeof salvo?.config.velocidade === "number" ? salvo.config.velocidade : VOZ_PADRAO.velocidade;
  return { disponivel: Boolean(ctx.fala), voz, velocidade, vozes: VOZES_FALA };
}

export async function salvarVoz(ctx: Contexto, ator: Ator, entrada: { voz: string; velocidade: number }) {
  if (!(VOZES_FALA as readonly string[]).includes(entrada.voz)) throw AppError.requisicaoInvalida("Essa voz não existe.");
  const velocidade = Math.min(1.5, Math.max(0.8, Math.round(entrada.velocidade * 100) / 100));
  await integracoes.salvar(ctx.pool, "argos_voz", { config: { voz: entrada.voz, velocidade } });
  await auditar(ctx.pool, ator, "argos.voz", undefined, { voz: entrada.voz, velocidade });
  return configVoz(ctx);
}

/** Texto → MP3 com a voz configurada (ou outra, para ouvir antes de escolher). Frases repetidas saem do cache. */
export async function gerarFala(ctx: Contexto, texto: string, teste?: { voz?: string; velocidade?: number }) {
  if (!ctx.fala) throw AppError.indisponivel("A voz do servidor não está ligada. Defina OPENAI_CHAVE no Railway.");
  const limpo = texto.replace(/\s+/g, " ").trim().slice(0, 1200);
  if (limpo.length < 1) throw AppError.requisicaoInvalida("Nada para falar.");
  const cfg = await configVoz(ctx);
  const voz = teste?.voz && (VOZES_FALA as readonly string[]).includes(teste.voz) ? teste.voz : cfg.voz;
  const velocidade = teste?.velocidade ? Math.min(1.5, Math.max(0.8, teste.velocidade)) : cfg.velocidade;
  const chave = `${voz}|${velocidade}|${limpo}`;
  const guardado = cacheFala.get(chave);
  if (guardado) return guardado;
  try {
    const audio = await ctx.fala.falar(limpo, { voz, velocidade });
    cacheFala.set(chave, audio);
    if (cacheFala.size > 80) cacheFala.delete(cacheFala.keys().next().value!);
    return audio;
  } catch (erro) {
    ctx.log.warn({ erro: (erro as Error).message }, "falha ao gerar a voz");
    throw AppError.indisponivel("Não consegui gerar a voz agora.");
  }
}
