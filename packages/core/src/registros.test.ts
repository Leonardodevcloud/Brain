import { describe, expect, it } from "vitest";
import { calcularRevisarEm, esquemaAtualizarRegistro, esquemaCriarRegistro, formatarCodigo } from "./registros.js";

describe("regras de registro", () => {
  it("formata o código com três dígitos", () => {
    expect(formatarCodigo("pop", 14)).toBe("POP-014");
    expect(formatarCodigo("decisao", 1031)).toBe("DEC-1031");
  });

  it("calcula a próxima revisão por tipo", () => {
    const base = new Date("2026-10-26T15:00:00Z");
    expect(calcularRevisarEm("pop", base)).toBe("2027-01-24");
    expect(calcularRevisarEm("nota", base)).toBe("2026-11-02");
    expect(calcularRevisarEm("decisao", base)).toBeNull();
  });

  it("aplica padrões ao criar", () => {
    const r = esquemaCriarRegistro.parse({ tipo: "pop", titulo: "Troca em rota", conteudo: "Passos" });
    expect(r).toMatchObject({ area: "operacoes", empresa: "todas", publicar: false, relacoes: [] });
  });

  it("exige ao menos um campo além do motivo ao atualizar", () => {
    expect(esquemaAtualizarRegistro.safeParse({ motivo: "nada mudou" }).success).toBe(false);
    expect(esquemaAtualizarRegistro.safeParse({ motivo: "novo prazo", titulo: "Novo título" }).success).toBe(true);
  });
});
