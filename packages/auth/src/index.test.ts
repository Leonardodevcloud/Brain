import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Cofre,
  EmissorTokens,
  hashFalso,
  conferirSenha,
  gerarHashSenha,
  gerarTokenConector,
  hashToken,
  validarForcaSenha,
} from "./index.js";

describe("auth", () => {
  it("gera e confere hash de senha", async () => {
    const hash = await gerarHashSenha("senhaForte123");
    expect(await conferirSenha("senhaForte123", hash)).toBe(true);
    expect(await conferirSenha("outra", hash)).toBe(false);
  });

  it("o hash falso é um bcrypt válido que nunca confere", async () => {
    expect(await conferirSenha("qualquer coisa", await hashFalso())).toBe(false);
  });

  it("valida a força da senha", () => {
    expect(validarForcaSenha("curta1")).not.toBeNull();
    expect(validarForcaSenha("somenteletras")).not.toBeNull();
    expect(validarForcaSenha("letras12345")).toBeNull();
  });

  it("emite e verifica tokens de acesso", async () => {
    const emissor = new EmissorTokens("x".repeat(40));
    const token = await emissor.emitirAcesso({ usuarioId: "u-1", papel: "admin" });
    expect(await emissor.verificarAcesso(token)).toEqual({ usuarioId: "u-1", papel: "admin" });
    await expect(new EmissorTokens("y".repeat(40)).verificarAcesso(token)).rejects.toMatchObject({ status: 401 });
  });

  it("gera token de conector com prefixo e hash", () => {
    const { token, prefixo, hash } = gerarTokenConector();
    expect(token.startsWith("cbr_")).toBe(true);
    expect(prefixo).toBe(token.slice(0, 8));
    expect(hash).toBe(hashToken(token));
  });

  it("cifra e decifra segredos", () => {
    const cofre = new Cofre(randomBytes(32).toString("base64"));
    const pacote = cofre.cifrar("refresh-token-do-google");
    expect(pacote).not.toContain("refresh");
    expect(cofre.decifrar(pacote)).toBe("refresh-token-do-google");
  });
});
