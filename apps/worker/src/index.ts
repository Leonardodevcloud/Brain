import { setTimeout as esperar } from "node:timers/promises";
import cron from "node-cron";
import { pino } from "pino";
import { sincronizarAcesso } from "@cerebro/central";
import { criarPool, jobs, migrar } from "@cerebro/db";
import { agendarRegrasDoCodigo, conhecimento, criarContexto, fontes, lerAmbiente, tarefas } from "@cerebro/servicos";
import { executarProximo } from "./processar.js";

const ambiente = lerAmbiente();
const log = pino({ name: "cerebro-worker", level: ambiente.NODE_ENV === "production" ? "info" : "debug" });
const pool = criarPool({ url: ambiente.DATABASE_URL, ssl: ambiente.DATABASE_SSL, nomeAplicacao: "cerebro-worker" });
// Seguro rodar junto com a API: a migration usa trava no banco.
await migrar(pool);
const ctx = criarContexto(pool, ambiente, log);

const FUSO = "America/Bahia";
let rodando = true;

/** Executa uma rotina agendada sem derrubar o processo se ela falhar. */
function agendar(nome: string, expressao: string, rotina: () => Promise<unknown>) {
  cron.schedule(
    expressao,
    async () => {
      try {
        const resultado = await rotina();
        log.info({ rotina: nome, resultado }, "rotina concluída");
      } catch (erro) {
        log.error({ rotina: nome, erro }, "rotina falhou");
      }
    },
    { timezone: FUSO, noOverlap: true, name: nome },
  );
}

// 06:05 — o que passou da data de revisão vai para "Revisar".
agendar("marcar_vencidos", "5 6 * * *", async () => (await conhecimento.marcarVencidos(ctx)).length);
// A cada 10 min — caixa cerebro@ (se configurada).
if (ctx.imap) agendar("ler_email", "*/10 * * * *", () => fontes.sincronizarEmail(ctx));
// A cada 15 min — devolve à fila jobs presos por um worker que caiu.
agendar("liberar_presos", "*/15 * * * *", () => jobs.liberarPresos(pool, 15));
// 04:30 — atualiza as views do Argos com tabelas e colunas novas da Central.
if (ambiente.ARGOS_DB_SENHA) {
  const senha = ambiente.ARGOS_DB_SENHA;
  agendar("sincronizar_central", "30 4 * * *", () => sincronizarAcesso(pool, senha));
}
// 05:10 — relê as regras de negócio do código da Central (só os arquivos que mudaram).
if (ambiente.CENTRAL_GITHUB_TOKEN) agendar("regras_codigo_central", "10 5 * * *", () => agendarRegrasDoCodigo(ctx));
// 00:10 — tarefas que se repetem: cria a próxima quando a data chega.
agendar("tarefas_recorrentes", "10 0 * * *", () => tarefas.gerarRecorrencias(ctx));
// Domingo 03:00 — limpa jobs concluídos há mais de 30 dias.
agendar("limpar_fila", "0 3 * * 0", () => jobs.limparConcluidos(pool, 30));

/** Laço principal: drena a fila e, vazia, espera um pouco antes de olhar de novo. */
async function laco() {
  log.info({ imap: Boolean(ctx.imap), ia: Boolean(ctx.ia), embeddings: Boolean(ctx.embeddings) }, "worker no ar");
  while (rodando) {
    try {
      const houve = await executarProximo(ctx);
      if (!houve) await esperar(3000);
    } catch (erro) {
      log.error({ erro }, "falha ao ler a fila");
      await esperar(10_000);
    }
  }
}

async function encerrar() {
  rodando = false;
  for (const tarefa of cron.getTasks().values()) await tarefa.stop();
  await esperar(500);
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void encerrar());
process.on("SIGINT", () => void encerrar());

await laco();
