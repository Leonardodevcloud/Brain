import { pino } from "pino";
import { criarPool } from "@cerebro/db";
import { criarContexto, lerAmbiente } from "@cerebro/servicos";
import { criarAppMcp } from "./app.js";

const ambiente = lerAmbiente();
// O token pode vir no caminho: nunca registrar URLs completas.
const log = pino({ name: "cerebro-mcp", level: ambiente.NODE_ENV === "production" ? "info" : "debug", redact: ["req.url", "url"] });

const pool = criarPool({ url: ambiente.DATABASE_URL, ssl: ambiente.DATABASE_SSL, nomeAplicacao: "cerebro-mcp" });
const ctx = criarContexto(pool, ambiente, log);
const servidor = criarAppMcp(ctx).listen(ambiente.PORT, () => log.info({ porta: ambiente.PORT }, "MCP no ar"));

async function encerrar() {
  servidor.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void encerrar());
process.on("SIGINT", () => void encerrar());
