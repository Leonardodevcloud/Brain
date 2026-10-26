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
    formulario.append("response_format", "json");
    formulario.append("temperature", "0");
    // Vocabulário da casa ajuda o Whisper com nomes próprios.
    formulario.append("prompt", "Central Tutts, motoboy, POP, Cérebro, Argos, Notion, Fathom, Plific, SLA, roteirizador.");

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
    const dados = (await resposta.json()) as { text?: string };
    return (dados.text ?? "").trim();
  }
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
