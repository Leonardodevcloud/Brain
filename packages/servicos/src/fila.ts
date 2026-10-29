import { jobs, type Executor } from "@cerebro/db";

/** Tipos de job que o worker sabe executar. */
export const JOB = {
  indexarRegistro: "indexar_registro",
  gerarAta: "gerar_ata",
  extrairConversaClaude: "extrair_conversa_claude",
  extrairEmail: "extrair_email",
  regrasCodigo: "regras_codigo_central",
} as const;
export type TipoJob = (typeof JOB)[keyof typeof JOB];

export const fila = {
  indexar: (db: Executor, registroId: string) =>
    jobs.enfileirar(db, JOB.indexarRegistro, { registroId }, { chave: `indexar:${registroId}` }),

  gerarAta: (db: Executor, reuniaoId: string) =>
    jobs.enfileirar(db, JOB.gerarAta, { reuniaoId }, { chave: `ata:${reuniaoId}`, maxTentativas: 4 }),

  extrairConversa: (db: Executor, conversa: { id: string; titulo: string; texto: string; criadaEm: string | null }) =>
    jobs.enfileirar(db, JOB.extrairConversaClaude, conversa, { chave: `claude:${conversa.id}`, maxTentativas: 3 }),

  extrairEmail: (db: Executor, email: { chave: string; assunto: string; de: string; data: string | null; texto: string }) =>
    jobs.enfileirar(db, JOB.extrairEmail, email, { chave: email.chave, maxTentativas: 3 }),
};
