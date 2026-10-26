import { pino } from "pino";
import { EmissorTokens } from "@cerebro/auth";
import { sincronizarAcesso } from "@cerebro/central";
import { criarPool, migrar } from "@cerebro/db";
import { criarContexto, lerAmbiente } from "@cerebro/servicos";
import { criarApp } from "./app.js";

const ambiente = lerAmbiente();
const log = pino({ name: "cerebro-api", level: ambiente.NODE_ENV === "production" ? "info" : "debug" });

if (!ambiente.JWT_SEGREDO) {
  log.fatal("Defina JWT_SEGREDO (pelo menos 32 caracteres).");
  process.exit(1);
}

const pool = criarPool({ url: ambiente.DATABASE_URL, ssl: ambiente.DATABASE_SSL });
// A API é quem aplica as migrations ao subir; o worker e o MCP só esperam o schema existir.
const migracao = await migrar(pool);
log.info(migracao, "migrations conferidas");

// Acesso do Argos à Central: usuário somente leitura e views sem dados pessoais.
if (ambiente.ARGOS_DB_SENHA) {
  try {
    const r = await sincronizarAcesso(pool, ambiente.ARGOS_DB_SENHA);
    log.info({ tabelas: r.tabelas, colunasOcultas: r.colunasOcultas, bloqueadas: r.tabelasBloqueadas.length }, "acesso do Argos à Central sincronizado");
  } catch (erro) {
    log.error({ erro: (erro as Error).message }, "não foi possível sincronizar o acesso do Argos à Central");
  }
}

const ctx = criarContexto(pool, ambiente, log);
const app = criarApp({ ctx, emissor: new EmissorTokens(ambiente.JWT_SEGREDO) });

const servidor = app.listen(ambiente.PORT, () => log.info({ porta: ambiente.PORT }, "API no ar"));

async function encerrar(sinal: string) {
  log.info({ sinal }, "encerrando");
  servidor.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void encerrar("SIGTERM"));
process.on("SIGINT", () => void encerrar("SIGINT"));
