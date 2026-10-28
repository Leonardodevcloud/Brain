import { z } from "zod";

const vazioParaUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const opcional = <T extends z.ZodType>(t: T) => z.preprocess(vazioParaUndefined, t.optional());
const booleano = z.preprocess(vazioParaUndefined, z.enum(["true", "false"]).default("false")).transform((v) => v === "true");

/** Todas as variáveis de ambiente, validadas num só lugar. Cada app usa as que precisa. */
const esquemaAmbiente = z.object({
  NODE_ENV: z.preprocess(vazioParaUndefined, z.enum(["development", "production", "test"]).default("development")),
  DATABASE_URL: z.string().min(1, "Defina DATABASE_URL."),
  DATABASE_SSL: booleano,
  PORT: z.preprocess(vazioParaUndefined, z.coerce.number().int().default(3000)),
  /** Quantos proxies ficam à frente da API (Railway + servidor da web = 2). Define o IP real para o limite de tentativas. */
  CONFIAR_PROXY: z.preprocess(vazioParaUndefined, z.coerce.number().int().min(0).max(5).default(1)),

  JWT_SEGREDO: opcional(z.string().min(32, "JWT_SEGREDO precisa de pelo menos 32 caracteres.")),
  CEREBRO_CHAVE_CIFRA: opcional(z.string()),
  URL_WEB: z.preprocess(vazioParaUndefined, z.url().default("http://localhost:5173")),
  URL_API: z.preprocess(vazioParaUndefined, z.url().default("http://localhost:3000")),

  IA_ANALISE_BASE_URL: z.preprocess(vazioParaUndefined, z.url().default("https://api.deepseek.com")),
  IA_ANALISE_CHAVE: opcional(z.string()),
  IA_ANALISE_MODELO: z.preprocess(vazioParaUndefined, z.string().default("deepseek-flash")),
  // Raciocínio do modelo no Argos: "desligado" responde na hora; "baixo" pensa um pouco antes (mais lento).
  ARGOS_RACIOCINIO: z.preprocess(vazioParaUndefined, z.enum(["desligado", "baixo", "alto"]).default("desligado")),
  // Provedor opcional para conteúdo restrito (mesmo modelo hospedado fora da China).
  IA_RESTRITO_BASE_URL: opcional(z.url()),
  IA_RESTRITO_CHAVE: opcional(z.string()),
  IA_RESTRITO_MODELO: opcional(z.string()),

  GEMINI_CHAVE: opcional(z.string()),
  EMBEDDINGS_DIMENSOES: z.preprocess(vazioParaUndefined, z.coerce.number().int().min(128).max(3072).default(768)),

  // Acesso do Argos ao banco da Central (usuário somente leitura criado pelo próprio Cérebro).
  ARGOS_DB_SENHA: opcional(z.string().min(24, "ARGOS_DB_SENHA precisa de pelo menos 24 caracteres.")),

  // Voz (Whisper). Padrão: Groq, compatível com a API da OpenAI.
  GROQ_CHAVE: opcional(z.string()),
  VOZ_BASE_URL: z.preprocess(vazioParaUndefined, z.url().default("https://api.groq.com/openai/v1")),
  VOZ_MODELO: z.preprocess(vazioParaUndefined, z.string().default("whisper-large-v3-turbo")),
  // Voz do Argos gerada no servidor (OpenAI): a mesma em qualquer aparelho.
  OPENAI_CHAVE: opcional(z.string()),
  FALA_BASE_URL: z.preprocess(vazioParaUndefined, z.url().default("https://api.openai.com/v1")),
  FALA_MODELO: z.preprocess(vazioParaUndefined, z.string().default("gpt-4o-mini-tts")),

  FATHOM_WEBHOOK_SEGREDO: opcional(z.string()),

  GOOGLE_CLIENT_ID: opcional(z.string()),
  GOOGLE_CLIENT_SECRET: opcional(z.string()),


  IMAP_HOST: opcional(z.string()),
  IMAP_PORTA: z.preprocess(vazioParaUndefined, z.coerce.number().int().default(993)),
  IMAP_SEGURO: z.preprocess(vazioParaUndefined, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
  IMAP_USUARIO: opcional(z.string()),
  IMAP_SENHA: opcional(z.string()),
  IMAP_PASTA: z.preprocess(vazioParaUndefined, z.string().default("INBOX")),
});

export type Ambiente = z.infer<typeof esquemaAmbiente>;

export function lerAmbiente(env: NodeJS.ProcessEnv = process.env): Ambiente {
  const resultado = esquemaAmbiente.safeParse(env);
  if (!resultado.success) {
    const problemas = resultado.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${problemas}`);
  }
  return resultado.data;
}
