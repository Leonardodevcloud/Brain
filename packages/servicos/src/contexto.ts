import { Cofre } from "@cerebro/auth";
import type { Papel } from "@cerebro/core";
import { auditoria, type Canal, type Executor, type Pool } from "@cerebro/db";
import {
  EmbeddingsGemini,
  ProvedorCompativelOpenAI,
  TranscricaoCompativelOpenAI,
  type ProvedorEmbeddings,
  type ProvedorTexto,
  type ProvedorTranscricao,
} from "@cerebro/ia";
import { ClienteGoogleAgenda, ClienteNotion, type ConfigImap } from "@cerebro/integracoes";
import type { Ambiente } from "./config.js";

export interface Log {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** Quem está agindo: uma pessoa (web ou Claude) ou o próprio sistema (worker, webhook). */
export interface Ator {
  usuarioId: string | null;
  papel: Papel | "sistema";
  canal: Canal;
  ip?: string | null;
}

export const ATOR_SISTEMA: Ator = { usuarioId: null, papel: "sistema", canal: "worker" };

/** Tudo de que os serviços precisam, montado uma vez por processo. */
export interface Contexto {
  pool: Pool;
  log: Log;
  ambiente: Ambiente;
  /** IA de análise (DeepSeek). `null` se não configurada: o cérebro funciona, só sem respostas geradas. */
  ia: ProvedorTexto | null;
  /** IA para conteúdo restrito. Sem ela, conteúdo restrito nunca vai para IA externa. */
  iaRestrita: ProvedorTexto | null;
  embeddings: ProvedorEmbeddings | null;
  /** Whisper para o Argos. `null` = sem voz (o Argos ainda aceita texto digitado). */
  voz: ProvedorTranscricao | null;
  cofre: Cofre | null;
  google: ClienteGoogleAgenda | null;
  notion: ClienteNotion | null;
  imap: ConfigImap | null;
  agora: () => Date;
}

export function criarContexto(pool: Pool, ambiente: Ambiente, log: Log): Contexto {
  const ia = ambiente.IA_ANALISE_CHAVE
    ? new ProvedorCompativelOpenAI({
        baseUrl: ambiente.IA_ANALISE_BASE_URL,
        chave: ambiente.IA_ANALISE_CHAVE,
        modelo: ambiente.IA_ANALISE_MODELO,
      })
    : null;
  const iaRestrita =
    ambiente.IA_RESTRITO_BASE_URL && ambiente.IA_RESTRITO_CHAVE && ambiente.IA_RESTRITO_MODELO
      ? new ProvedorCompativelOpenAI({
          baseUrl: ambiente.IA_RESTRITO_BASE_URL,
          chave: ambiente.IA_RESTRITO_CHAVE,
          modelo: ambiente.IA_RESTRITO_MODELO,
        })
      : null;

  return {
    pool,
    log,
    ambiente,
    ia,
    iaRestrita,
    embeddings: ambiente.GEMINI_CHAVE
      ? new EmbeddingsGemini({ chave: ambiente.GEMINI_CHAVE, dimensoes: ambiente.EMBEDDINGS_DIMENSOES })
      : null,
    voz: ambiente.GROQ_CHAVE
      ? new TranscricaoCompativelOpenAI({ baseUrl: ambiente.VOZ_BASE_URL, chave: ambiente.GROQ_CHAVE, modelo: ambiente.VOZ_MODELO })
      : null,
    cofre: ambiente.CEREBRO_CHAVE_CIFRA ? new Cofre(ambiente.CEREBRO_CHAVE_CIFRA) : null,
    google:
      ambiente.GOOGLE_CLIENT_ID && ambiente.GOOGLE_CLIENT_SECRET
        ? new ClienteGoogleAgenda({
            clientId: ambiente.GOOGLE_CLIENT_ID,
            clientSecret: ambiente.GOOGLE_CLIENT_SECRET,
            redirectUri: `${ambiente.URL_API.replace(/\/$/, "")}/integracoes/google/retorno`,
          })
        : null,
    notion: ambiente.NOTION_TOKEN ? new ClienteNotion(ambiente.NOTION_TOKEN) : null,
    imap:
      ambiente.IMAP_HOST && ambiente.IMAP_USUARIO && ambiente.IMAP_SENHA
        ? {
            host: ambiente.IMAP_HOST,
            porta: ambiente.IMAP_PORTA,
            seguro: ambiente.IMAP_SEGURO,
            usuario: ambiente.IMAP_USUARIO,
            senha: ambiente.IMAP_SENHA,
            pasta: ambiente.IMAP_PASTA,
          }
        : null,
    agora: () => new Date(),
  };
}

/** Atalho para auditar uma ação de um ator. */
export function auditar(
  db: Executor,
  ator: Ator,
  acao: string,
  alvo?: { entidade: string; id: string },
  detalhes?: Record<string, unknown>,
) {
  return auditoria.registrar(db, {
    usuarioId: ator.usuarioId,
    canal: ator.canal,
    acao,
    entidade: alvo?.entidade,
    entidadeId: alvo?.id,
    detalhes,
    ip: ator.ip ?? null,
  });
}

/** Data de hoje (AAAA-MM-DD) no fuso de Salvador, que é o das operações. */
export function hojeLocal(agora: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia" }).format(agora);
}
