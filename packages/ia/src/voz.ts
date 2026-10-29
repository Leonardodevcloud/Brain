/** Transforma fala em texto. */
export interface ProvedorTranscricao {
  readonly nome: string;
  transcrever(audio: Uint8Array, mime: string): Promise<string>;
}

const EXTENSAO: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/**
 * Whisper por qualquer API compatível com a da OpenAI (`/audio/transcriptions`).
 * Padrão: Groq com whisper-large-v3-turbo, rápido e barato. Trocar de provedor = trocar variáveis.
 */
export class TranscricaoCompativelOpenAI implements ProvedorTranscricao {
  readonly nome: string;

  constructor(private readonly cfg: { baseUrl: string; chave: string; modelo: string; timeoutMs?: number }) {
    this.nome = `${new URL(cfg.baseUrl).hostname}/${cfg.modelo}`;
  }

  async transcrever(audio: Uint8Array, mime: string): Promise<string> {
    const tipo = mime.split(";")[0]!.trim() || "audio/webm";
    const formulario = new FormData();
    formulario.append("file", new Blob([new Uint8Array(audio)], { type: tipo }), `fala.${EXTENSAO[tipo] ?? "webm"}`);
    formulario.append("model", this.cfg.modelo);
    formulario.append("language", "pt");
    formulario.append("response_format", "verbose_json");
    formulario.append("temperature", "0");
    // Vocabulário da casa ajuda o Whisper com nomes próprios.
    formulario.append(
      "prompt",
      "Argos, como está a disponibilidade hoje? Qual loja está com mais faltas? Motoboys em loja, faltando, sem contato. Entregas de hoje, SLA, faturamento, margem, saques em aberto. Central Tutts, Cérebro, POP, Plific, roteirizador. Marca uma reunião amanhã às 15h com contato@tutts.com.br no Google Meet.",
    );

    const resposta = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.chave}` },
      body: formulario,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new Error(`Transcrição falhou (${resposta.status}): ${corpo.slice(0, 300)}`);
    }
    const dados = (await resposta.json()) as {
      text?: string;
      segments?: { text?: string; no_speech_prob?: number; avg_logprob?: number }[];
    };
    return lerTranscricao(dados);
  }
}

/**
 * E-mail ditado em voz: "contato arroba tutts ponto com ponto br" → "contato@tutts.com.br".
 * Também junta "contato @ tutts . com . br" e "marcos ponto gabriel arroba ..." e deixa o e-mail em minúsculas.
 */
export function normalizarEmailFalado(texto: string): string {
  let t = texto.replace(/\s+(?:arroba|arrouba|aroba)\s+/gi, "@").replace(/\s*@\s*/g, "@");
  if (!t.includes("@")) return texto;
  // Domínio: "@tutts ponto com ponto br" / "@tutts . com . br"
  t = t.replace(/@([a-z0-9À-ÿ_-]+)((?:\s*(?:\bponto\b|\.)\s*[a-z0-9_-]+)+)/gi, (_m, nome: string, resto: string) => `@${nome}${resto.replace(/\s*(?:\bponto\b|\.)\s*/gi, ".")}`);
  // Parte antes do @: "marcos ponto gabriel@" → "marcos.gabriel@"
  t = t.replace(/([a-z0-9_-]+)\s+ponto\s+([a-z0-9_-]+)@/gi, "$1.$2@");
  // Sem espaços dentro do e-mail e em minúsculas.
  return t.replace(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, (e) => e.toLowerCase());
}

/** Marca colocada no fim quando o Whisper teve pouca confiança: o Argos confirma antes de agir. */
export const MARCA_INCERTA = "[áudio pouco claro]";

/**
 * Tira os trechos que o Whisper "ouviu" no silêncio (alta chance de não ser fala) e
 * marca a transcrição quando a confiança média é baixa.
 */
export function lerTranscricao(dados: { text?: string; segments?: { text?: string; no_speech_prob?: number; avg_logprob?: number }[] }): string {
  const segmentos = dados.segments ?? [];
  if (!segmentos.length) return normalizarEmailFalado((dados.text ?? "").trim());
  const bons = segmentos.filter((s) => (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.6);
  const texto = bons
    .map((s) => (s.text ?? "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!texto) return "";
  const media = bons.reduce((t, s) => t + (s.avg_logprob ?? 0), 0) / bons.length;
  const final = normalizarEmailFalado(texto);
  return media < -0.9 ? `${final} ${MARCA_INCERTA}` : final;
}

/** Versão para ser falada: sem Markdown, sem citações [1], curta. */
export function textoParaFala(markdown: string, limite = 320): string {
  const limpo = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[(\d+)\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`>|]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (limpo.length <= limite) return limpo;
  // Corta no fim de uma frase, para não parar no meio.
  const frases = limpo.match(/[^.!?]+[.!?]+/g) ?? [limpo];
  let saida = "";
  for (const f of frases) {
    if ((saida + f).length > limite) break;
    saida += f;
  }
  return (saida || `${limpo.slice(0, limite - 1)}…`).trim();
}

// ───────────────────────────── Voz do Argos (texto → fala) ─────────────────────────────

/** Vozes do gpt-4o-mini-tts. Todas falam português; as mais naturais em pt-BR primeiro. */
export const VOZES_FALA = ["marin", "cedar", "coral", "nova", "shimmer", "sage", "ballad", "ash", "verse", "alloy", "echo", "fable", "onyx"] as const;
export type VozFala = (typeof VOZES_FALA)[number];

/** Gera a fala no servidor: a mesma voz em qualquer aparelho. */
export interface ProvedorFala {
  readonly nome: string;
  falar(texto: string, opcoes: { voz: string; velocidade: number }): Promise<Uint8Array>;
}

// Como a voz deve soar: o gpt-4o-mini-tts segue instruções de tom e ritmo.
const INSTRUCOES_FALA =
  "Fale em português do Brasil, com sotaque brasileiro natural. Tom de um colega de trabalho simpático e seguro: " +
  "caloroso, direto, conversado, nunca robótico nem de locutor. Ritmo ágil, frases fluidas, pausas curtas. " +
  "Diga números e valores como uma pessoa diria (\"trinta e oito mil reais\", \"noventa e um por cento\").";

/** OpenAI `/audio/speech` (ou API compatível). */
export class FalaCompativelOpenAI implements ProvedorFala {
  readonly nome: string;

  constructor(private readonly cfg: { baseUrl: string; chave: string; modelo: string; timeoutMs?: number }) {
    this.nome = `${new URL(cfg.baseUrl).hostname}/${cfg.modelo}`;
  }

  async falar(texto: string, opcoes: { voz: string; velocidade: number }): Promise<Uint8Array> {
    const resposta = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.chave}` },
      body: JSON.stringify({
        model: this.cfg.modelo,
        voice: opcoes.voz,
        input: texto,
        instructions: INSTRUCOES_FALA,
        speed: opcoes.velocidade,
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new Error(`A voz falhou (${resposta.status}): ${corpo.slice(0, 300)}`);
    }
    return new Uint8Array(await resposta.arrayBuffer());
  }
}
