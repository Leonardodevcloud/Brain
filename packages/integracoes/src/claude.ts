import { unzipSync, strFromU8 } from "fflate";

export interface ConversaClaude {
  id: string;
  titulo: string;
  criadaEm: string | null;
  atualizadaEm: string | null;
  texto: string;
  mensagens: number;
}

interface ConversaExportada {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: { sender?: string; text?: string; content?: { type?: string; text?: string }[] }[];
}

/**
 * Lê o arquivo exportado do Claude (Configurações › Privacidade › Exportar dados).
 * O .zip traz `conversations.json`: uma lista de conversas com as mensagens.
 */
export function lerExportacaoClaude(zip: Uint8Array): ConversaClaude[] {
  const arquivos = unzipSync(zip, { filter: (f) => f.name.endsWith("conversations.json") });
  const nome = Object.keys(arquivos)[0];
  if (!nome) throw new Error("O arquivo não tem conversations.json. Confira se é a exportação do Claude.");
  const lista = JSON.parse(strFromU8(arquivos[nome]!)) as ConversaExportada[];
  if (!Array.isArray(lista)) throw new Error("conversations.json em formato inesperado.");

  return lista
    .filter((c) => c.uuid && Array.isArray(c.chat_messages) && c.chat_messages.length > 0)
    .map((c) => {
      const linhas = c.chat_messages!.map((m) => {
        const texto =
          m.text ??
          (m.content ?? [])
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
        return `${m.sender === "human" ? "Pessoa" : "Claude"}: ${texto ?? ""}`.trim();
      });
      return {
        id: c.uuid!,
        titulo: c.name?.trim() || "Conversa sem título",
        criadaEm: c.created_at ?? null,
        atualizadaEm: c.updated_at ?? null,
        texto: linhas.join("\n\n"),
        mensagens: linhas.length,
      };
    });
}
