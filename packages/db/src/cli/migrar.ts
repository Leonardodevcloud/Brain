import { criarPool } from "../conexao.js";
import { migrar } from "../migrar.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Defina DATABASE_URL para rodar as migrations.");
  process.exit(1);
}

const pool = criarPool({ url, ssl: process.env.DATABASE_SSL === "true", max: 1, nomeAplicacao: "cerebro-migrar" });
try {
  const { aplicadas } = await migrar(pool);
  console.log(aplicadas.length ? `Migrations aplicadas: ${aplicadas.join(", ")}` : "Banco já está atualizado.");
} finally {
  await pool.end();
}
