import { createHmac } from "node:crypto";
import { z } from "zod";
import { compararTempoConstante } from "./util.js";

/**
 * Webhook da Fathom (padrão Standard Webhooks): cabeçalhos `webhook-id`,
 * `webhook-timestamp` e `webhook-signature` ("v1,<base64> v1,<base64>").
 * O segredo vem no formato `whsec_<base64>`.
 */
export function verificarAssinaturaFathom(
  segredo: string,
  cabecalhos: { id?: string; timestamp?: string; assinatura?: string },
  corpoBruto: string,
  agora = Date.now(),
  toleranciaSeg = 300,
): boolean {
  const { id, timestamp, assinatura } = cabecalhos;
  if (!id || !timestamp || !assinatura) return false;
  const instante = Number(timestamp);
  if (!Number.isFinite(instante) || Math.abs(agora / 1000 - instante) > toleranciaSeg) return false;

  // Padrão Standard Webhooks: "whsec_" + base64. Como a Fathom não documenta o formato,
  // aceitamos também o segredo usado como texto puro.
  const chaves = [Buffer.from(segredo.replace(/^whsec_/, ""), "base64"), Buffer.from(segredo, "utf8")];
  const conteudo = `${id}.${timestamp}.${corpoBruto}`;
  const esperadas = chaves.map((chave) => createHmac("sha256", chave).update(conteudo).digest("base64"));
  const recebidas = assinatura.split(" ").map((parte) => parte.split(",")[1] ?? parte);
  return recebidas.some((recebida) => esperadas.some((esperada) => compararTempoConstante(recebida, esperada)));
}

// O formato exato do payload deve ser conferido com uma chamada real; o parser é tolerante.
const esquemaFala = z
  .object({
    speaker: z.object({ display_name: z.string().nullish(), name: z.string().nullish() }).partial().nullish(),
    text: z.string().nullish(),
    timestamp: z.union([z.string(), z.number()]).nullish(),
  })
  .loose();

const esquemaReuniaoFathom = z
  .object({
    recording_id: z.union([z.string(), z.number()]).nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    title: z.string().nullish(),
    meeting_title: z.string().nullish(),
    url: z.string().nullish(),
    share_url: z.string().nullish(),
    created_at: z.string().nullish(),
    scheduled_start_time: z.string().nullish(),
    recording_start_time: z.string().nullish(),
    recording_end_time: z.string().nullish(),
    transcript: z.union([z.array(esquemaFala), z.string()]).nullish(),
  })
  .loose();

export interface ReuniaoRecebida {
  externoId: string;
  titulo: string;
  inicio: Date | null;
  duracaoSeg: number | null;
  url: string | null;
  transcricao: string;
}

/** Converte o payload da Fathom numa reunião pronta para virar ata. `null` se não houver transcrição. */
export function lerReuniaoFathom(payload: unknown): ReuniaoRecebida | null {
  const lido = esquemaReuniaoFathom.safeParse(payload);
  if (!lido.success) return null;
  const dados = lido.data;
  const externoId = dados.recording_id ?? dados.id;
  if (externoId === null || externoId === undefined) return null;

  let transcricao = "";
  if (typeof dados.transcript === "string") transcricao = dados.transcript;
  else if (Array.isArray(dados.transcript)) {
    transcricao = dados.transcript
      .filter((f) => f.text)
      .map((f) => `${f.speaker?.display_name ?? f.speaker?.name ?? "Participante"}: ${f.text}`)
      .join("\n");
  }
  if (!transcricao.trim()) return null;

  const inicioTexto = dados.recording_start_time ?? dados.scheduled_start_time ?? dados.created_at;
  const inicio = inicioTexto ? new Date(inicioTexto) : null;
  const fim = dados.recording_end_time ? new Date(dados.recording_end_time) : null;
  return {
    externoId: String(externoId),
    titulo: (dados.meeting_title ?? dados.title ?? "Reunião sem título").slice(0, 200),
    inicio: inicio && !Number.isNaN(inicio.getTime()) ? inicio : null,
    duracaoSeg: inicio && fim ? Math.max(0, Math.round((fim.getTime() - inicio.getTime()) / 1000)) : null,
    url: dados.share_url ?? dados.url ?? null,
    transcricao,
  };
}
