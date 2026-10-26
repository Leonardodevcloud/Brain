import { AppError, NOME_TIPO, TIPOS_REGISTRO, esquemaCriarRegistro, type RespostaAssistenteDTO, type TipoRegistro } from "@cerebro/core";
import { registros, usuarios } from "@cerebro/db";
import {
  SISTEMA_ASSISTENTE,
  lerJson,
  mascarar,
  montarPedidoAssistente,
  restaurar,
  textoParaFala,
  type IntencaoAssistente,
} from "@cerebro/ia";
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

/** Comandos óbvios não precisam da IA: respondem na hora e funcionam mesmo sem DeepSeek. */
export function interpretarRapido(fala: string): IntencaoAssistente | null {
  const t = sem(fala).replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim().replace(/^(argos|ei argos|oi argos)\s+/, "");
  const vazio = { alvo: null, tipo: null, titulo: null, conteudo: null, fala: null };

  const tela = t.match(
    /^(?:abr(?:e|ir|a)|mostr(?:a|ar|e)|v(?:ai|a|ou) (?:pra|para)|ir (?:pra|para)|leva(?:r)? (?:pra|para)|quero ver)\s+(?:o |a |as |os )?(inicio|biblioteca|mapa|revisar|revisao|integracoes|perguntar|minha conta|conta)$/,
  );
  if (tela) {
    const nome = tela[1]!.replace("revisao", "revisar").replace("minha conta", "conta");
    return { intencao: "navegar", ...vazio, alvo: nome };
  }
  if (/(o que|tem (?:algo|alguma coisa)|quais|quantos?).*(revisar|aprovar|pendent|pendencia|vencid)/.test(t)) {
    return { intencao: "pendencias", ...vazio };
  }
  if (planoRapido(t) && !/\b(como (funciona|fazer|tratamos|trata)|qual (o|a) (regra|politica|procedimento)|pop)\b/.test(t)) {
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
export async function atenderFala(ctx: Contexto, ator: Ator, falaBruta: string): Promise<RespostaAssistenteDTO> {
  const fala = falaBruta.trim().slice(0, 1000);
  if (fala.length < 2) throw AppError.requisicaoInvalida("Não ouvi nada. Segure o espaço e fale de novo.");

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
