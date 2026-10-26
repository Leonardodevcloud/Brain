import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface ConfigImap {
  host: string;
  porta: number;
  seguro: boolean;
  usuario: string;
  senha: string;
  pasta?: string;
}

export interface EmailRecebido {
  uid: number;
  messageId: string | null;
  assunto: string;
  de: string;
  data: Date | null;
  texto: string;
}

/**
 * Lê os e-mails da caixa dedicada (ex.: cerebro@tutts.com.br) com UID maior que `desdeUid`.
 * Não marca nem apaga nada no servidor: o controle do que já foi lido é o `ultimoUid` guardado no cérebro.
 */
export async function lerEmailsNovos(
  cfg: ConfigImap,
  desdeUid: number,
  limite = 50,
): Promise<{ emails: EmailRecebido[]; ultimoUid: number }> {
  const cliente = new ImapFlow({
    host: cfg.host,
    port: cfg.porta,
    secure: cfg.seguro,
    auth: { user: cfg.usuario, pass: cfg.senha },
    logger: false,
  });
  await cliente.connect();
  // Somente leitura: o Cérebro não marca como lido, não move e não apaga nada.
  const trava = await cliente.getMailboxLock(cfg.pasta ?? "INBOX", { readOnly: true });
  const emails: EmailRecebido[] = [];
  let ultimoUid = desdeUid;
  try {
    for await (const msg of cliente.fetch(`${desdeUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      // `n:*` sempre devolve a última mensagem, mesmo se o UID dela for menor.
      if (msg.uid <= desdeUid || !msg.source) continue;
      const email = await simpleParser(msg.source);
      emails.push({
        uid: msg.uid,
        messageId: email.messageId ?? null,
        assunto: email.subject ?? "(sem assunto)",
        de: email.from?.text ?? "",
        data: email.date ?? null,
        texto: (email.text ?? "").slice(0, 50_000),
      });
      ultimoUid = Math.max(ultimoUid, msg.uid);
      if (emails.length >= limite) break;
    }
  } finally {
    trava.release();
    await cliente.logout().catch(() => undefined);
  }
  return { emails, ultimoUid };
}

/** Remove o histórico citado ("Em ... escreveu:") e a assinatura, que só repetem conteúdo. */
export function limparCorpoEmail(texto: string): string {
  const linhas = texto.split(/\r?\n/);
  const corte = linhas.findIndex(
    (l) => /^(em|on) .+ (escreveu|wrote):\s*$/i.test(l.trim()) || /^-{2,}\s*(mensagem original|original message)/i.test(l.trim()),
  );
  const util = (corte >= 0 ? linhas.slice(0, corte) : linhas).filter((l) => !l.startsWith(">"));
  const assinatura = util.findIndex((l) => l.trim() === "--");
  return (assinatura >= 0 ? util.slice(0, assinatura) : util).join("\n").trim();
}
