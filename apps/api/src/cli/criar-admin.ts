/**
 * Cria o primeiro administrador. Uso:
 *   pnpm db:admin --nome "Seu Nome" --email voce@tutts.com.br
 * A senha é pedida no terminal (não fica no histórico do shell).
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { criarPool, migrar } from "@cerebro/db";
import { acesso, criarContexto, lerAmbiente } from "@cerebro/servicos";

const { values } = parseArgs({
  // O pnpm repassa um "--" solto quando a pessoa usa `pnpm db:admin -- --nome ...`.
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { nome: { type: "string" }, email: { type: "string" }, papel: { type: "string", default: "admin" } },
});
if (!values.nome || !values.email) {
  console.error('Uso: pnpm db:admin --nome "Seu Nome" --email voce@tutts.com.br');
  process.exit(1);
}

const senha =
  process.env.SENHA_ADMIN ??
  (await (async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const s = await rl.question("Senha (mín. 10 caracteres, letras e números): ");
    rl.close();
    return s;
  })());

const ambiente = lerAmbiente();
const pool = criarPool({ url: ambiente.DATABASE_URL, ssl: ambiente.DATABASE_SSL });
const log = { info: () => {}, warn: console.warn, error: console.error };
try {
  await migrar(pool);
  const ctx = criarContexto(pool, ambiente, log);
  const u = await acesso.criarUsuario(ctx, null, {
    nome: values.nome,
    email: values.email,
    senha,
    papel: values.papel === "membro" ? "membro" : "admin",
  });
  console.log(`Usuário criado: ${u.nome} <${u.email}> (${u.papel})`);
} catch (erro) {
  console.error(erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
} finally {
  await pool.end();
}
