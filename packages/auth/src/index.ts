import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, errors as erroJose, jwtVerify } from "jose";
import { AppError, type Papel } from "@cerebro/core";

// ───────────────────────────── Senhas ─────────────────────────────

const CUSTO_BCRYPT = 12;

export function validarForcaSenha(senha: string): string | null {
  if (senha.length < 10) return "Use pelo menos 10 caracteres.";
  if (!/[a-zA-Z]/.test(senha) || !/\d/.test(senha)) return "Misture letras e números.";
  return null;
}

export const gerarHashSenha = (senha: string) => bcrypt.hash(senha, CUSTO_BCRYPT);
export const conferirSenha = (senha: string, hash: string) => bcrypt.compare(senha, hash);

let hashFalsoEmCache: Promise<string> | null = null;
/**
 * Hash para comparar quando o e-mail não existe: o tempo de resposta não revela
 * quais contas existem. Gerado uma vez por processo, de uma senha aleatória.
 */
export function hashFalso(): Promise<string> {
  hashFalsoEmCache ??= bcrypt.hash(randomBytes(24).toString("base64"), CUSTO_BCRYPT);
  return hashFalsoEmCache;
}

// ───────────────────────────── Tokens de acesso (JWT) ─────────────────────────────

export interface Sessao {
  usuarioId: string;
  papel: Papel;
}

export class EmissorTokens {
  private readonly chave: Uint8Array;

  constructor(
    segredo: string,
    private readonly validadeAcesso = "15m",
  ) {
    if (segredo.length < 32) throw new Error("JWT_SEGREDO precisa de pelo menos 32 caracteres.");
    this.chave = new TextEncoder().encode(segredo);
  }

  emitirAcesso(sessao: Sessao) {
    return new SignJWT({ papel: sessao.papel })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(sessao.usuarioId)
      .setIssuer("cerebro")
      .setAudience("cerebro-api")
      .setIssuedAt()
      .setExpirationTime(this.validadeAcesso)
      .sign(this.chave);
  }

  async verificarAcesso(token: string): Promise<Sessao> {
    try {
      const { payload } = await jwtVerify(token, this.chave, { issuer: "cerebro", audience: "cerebro-api" });
      const papel = payload.papel;
      if (typeof payload.sub !== "string" || (papel !== "admin" && papel !== "membro")) {
        throw AppError.naoAutenticado();
      }
      return { usuarioId: payload.sub, papel };
    } catch (erro) {
      if (erro instanceof AppError) throw erro;
      if (erro instanceof erroJose.JWTExpired) throw AppError.naoAutenticado();
      throw AppError.naoAutenticado("Não foi possível validar o seu acesso. Entre de novo.");
    }
  }
}

// ───────────────────────────── Tokens opacos ─────────────────────────────

/** Refresh tokens e tokens do conector: só o hash vai para o banco. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function gerarTokenOpaco(prefixo = ""): string {
  return `${prefixo}${randomBytes(32).toString("base64url")}`;
}

/** Token pessoal do conector do Claude: `cbr_` + 43 caracteres. Mostrado uma única vez. */
export function gerarTokenConector() {
  const token = gerarTokenOpaco("cbr_");
  return { token, prefixo: token.slice(0, 8), hash: hashToken(token) };
}

export function compararSeguro(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ───────────────────────────── Cifra de segredos ─────────────────────────────

/**
 * AES-256-GCM para segredos guardados no banco (refresh token do Google, senha IMAP...).
 * A chave vem de `CEREBRO_CHAVE_CIFRA` (32 bytes em base64) e nunca vai para o banco.
 */
export class Cofre {
  private readonly chave: Buffer;

  constructor(chaveBase64: string) {
    this.chave = Buffer.from(chaveBase64, "base64");
    if (this.chave.length !== 32) throw new Error("CEREBRO_CHAVE_CIFRA precisa ter 32 bytes em base64.");
  }

  cifrar(texto: string): string {
    const iv = randomBytes(12);
    const cifra = createCipheriv("aes-256-gcm", this.chave, iv);
    const conteudo = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
    return ["v1", iv.toString("base64url"), cifra.getAuthTag().toString("base64url"), conteudo.toString("base64url")].join(".");
  }

  decifrar(pacote: string): string {
    const [versao, iv, tag, conteudo] = pacote.split(".");
    if (versao !== "v1" || !iv || !tag || !conteudo) throw new Error("Segredo em formato desconhecido.");
    const decifra = createDecipheriv("aes-256-gcm", this.chave, Buffer.from(iv, "base64url"));
    decifra.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decifra.update(Buffer.from(conteudo, "base64url")), decifra.final()]).toString("utf8");
  }
}
