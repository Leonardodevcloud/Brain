import { createHmac, randomBytes } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { lerExportacaoClaude } from "./claude.js";
import { limparCorpoEmail } from "./email.js";
import { lerReuniaoFathom, verificarAssinaturaFathom } from "./fathom.js";

describe("fathom", () => {
  const chave = randomBytes(24);
  const segredo = `whsec_${chave.toString("base64")}`;
  const corpo = JSON.stringify({ recording_id: 42 });
  const agora = Date.UTC(2026, 9, 26, 12, 0, 0);
  const ts = String(Math.floor(agora / 1000));
  const assinar = (c: string) => createHmac("sha256", chave).update(`msg_1.${ts}.${c}`).digest("base64");

  it("aceita assinatura válida", () => {
    const ok = verificarAssinaturaFathom(segredo, { id: "msg_1", timestamp: ts, assinatura: `v1,${assinar(corpo)}` }, corpo, agora);
    expect(ok).toBe(true);
  });

  it("recusa corpo alterado, assinatura ausente ou fora do prazo", () => {
    const sig = `v1,${assinar(corpo)}`;
    expect(verificarAssinaturaFathom(segredo, { id: "msg_1", timestamp: ts, assinatura: sig }, `${corpo} `, agora)).toBe(false);
    expect(verificarAssinaturaFathom(segredo, { id: "msg_1", timestamp: ts }, corpo, agora)).toBe(false);
    expect(verificarAssinaturaFathom(segredo, { id: "msg_1", timestamp: ts, assinatura: sig }, corpo, agora + 3_600_000)).toBe(false);
  });

  it("lê transcrição em lista de falas", () => {
    const r = lerReuniaoFathom({
      recording_id: 77,
      meeting_title: "Alinhamento",
      share_url: "https://fathom.video/share/x",
      recording_start_time: "2026-10-26T13:00:00Z",
      recording_end_time: "2026-10-26T13:42:00Z",
      transcript: [
        { speaker: { display_name: "Ana" }, text: "Vamos decidir o horário.", timestamp: "00:00:01" },
        { speaker: { display_name: "Beto" }, text: "Até 8h30.", timestamp: "00:00:05" },
      ],
    });
    expect(r).toMatchObject({ externoId: "77", titulo: "Alinhamento", duracaoSeg: 2520 });
    expect(r?.transcricao).toBe("Ana: Vamos decidir o horário.\nBeto: Até 8h30.");
  });

  it("ignora payload sem transcrição", () => {
    expect(lerReuniaoFathom({ recording_id: 1, title: "x" })).toBeNull();
  });
});

describe("e-mail", () => {
  it("remove histórico citado e assinatura", () => {
    const corpo = "Fechado o novo prazo.\n\n--\nFulano\n\nEm seg., 20 out. escreveu:\n> mensagem antiga";
    expect(limparCorpoEmail(corpo)).toBe("Fechado o novo prazo.");
  });
});

describe("exportação do Claude", () => {
  it("lê conversations.json de dentro do zip", () => {
    const conversas = [
      {
        uuid: "c-1",
        name: "Regra de multa",
        created_at: "2026-10-20T10:00:00Z",
        chat_messages: [
          { sender: "human", text: "Como fica a multa?" },
          { sender: "assistant", content: [{ type: "text", text: "Só sem aviso." }] },
        ],
      },
      { uuid: "c-2", name: "Vazia", chat_messages: [] },
    ];
    const zip = zipSync({ "conversations.json": strToU8(JSON.stringify(conversas)) });
    const lidas = lerExportacaoClaude(zip);
    expect(lidas).toHaveLength(1);
    expect(lidas[0]).toMatchObject({ id: "c-1", titulo: "Regra de multa", mensagens: 2 });
    expect(lidas[0]!.texto).toBe("Pessoa: Como fica a multa?\n\nClaude: Só sem aviso.");
  });
});
