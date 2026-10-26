/**
 * Dados de demonstração para desenvolvimento local. NUNCA rode em produção:
 * apaga o schema `cerebro` do banco apontado por DATABASE_URL.
 *   pnpm --filter @cerebro/api demo
 */
import { esquemaCriarRegistro, type CriarRegistro } from "@cerebro/core";
import { criarPool, integracoes, jobs, migrar } from "@cerebro/db";
import { acesso, conhecimento, criarContexto, fontes, indexarRegistro, lerAmbiente, type Ator } from "@cerebro/servicos";

const ambiente = lerAmbiente();
if (ambiente.NODE_ENV === "production" || !/localhost|127\.0\.0\.1/.test(ambiente.DATABASE_URL)) {
  console.error("Recusado: o demo só roda contra um banco local.");
  process.exit(1);
}

const pool = criarPool({ url: ambiente.DATABASE_URL });
await pool.query("DROP SCHEMA IF EXISTS cerebro CASCADE");
await migrar(pool);

// IA de mentira só para gerar a ata de exemplo.
const iaDemo = {
  nome: "demo",
  async gerar() {
    return JSON.stringify({
      titulo: "Alinhamento semanal de supervisores",
      resumo:
        "A equipe revisou as faltas do primeiro turno e o atraso nas coletas em lojas que abrem mais tarde. Ficou decidido padronizar o aviso à loja e testar um motoboy reserva em Salvador por duas semanas.",
      decisoes: ["Aviso à loja sempre antes das 8h30", "Teste de motoboy reserva em Salvador por 2 semanas"],
      pendencias: [
        { tarefa: "Atualizar o POP-001 com o novo horário", responsavel: "Supervisão SSA", prazo: "2026-10-28" },
        { tarefa: "Escolher o motoboy reserva e a escala", responsavel: "Supervisão SSA", prazo: "2026-10-27" },
        { tarefa: "Avisar as lojas sobre o novo horário de aviso", responsavel: null, prazo: "2026-10-29" },
      ],
      clientes: [],
    });
  },
};
const log = { info() {}, warn() {}, error: console.error };
const ctx = { ...criarContexto(pool, ambiente, log), ia: iaDemo };

const admin = await acesso.criarUsuario(ctx, null, {
  nome: "Administrador Tutts",
  email: "admin@tutts.com.br",
  senha: "cerebro12345",
  papel: "admin",
});
const sup = await acesso.criarUsuario(ctx, null, { nome: "Supervisão SSA", email: "ssa@tutts.com.br", senha: "cerebro12345", papel: "membro" });
const eu: Ator = { usuarioId: admin.id, papel: "admin", canal: "web" };
const supervisor: Ator = { usuarioId: sup.id, papel: "membro", canal: "web" };

const novo = (d: Partial<CriarRegistro>) => esquemaCriarRegistro.parse(d);

const pop = await conhecimento.criarRegistro(
  ctx,
  eu,
  novo({
    tipo: "pop",
    titulo: "Troca de motoboy em rota",
    publicar: true,
    donoId: sup.id,
    conteudo: `## Objetivo
Garantir que nenhuma loja fique sem motoboy quando um profissional falta ou sai de rota no meio do turno.

## Quando usar
Ausência confirmada até 30 minutos após o início do turno, ou motoboy fora de rota por mais de 20 minutos.

## Passos
1. Confirmar a ausência no grupo da praça e registrar a ocorrência na Central.
2. Realocar o profissional da janela seguinte com menor distância até a loja.
3. Avisar a loja antes das 8h30 com o nome e a previsão de chegada.
4. Se não houver substituto em 40 minutos, acionar o supervisor de outra praça.

## Exceções
Clientes com alocação fixa: o substituto precisa ser aprovado pelo CEO.

## Indicador de sucesso
Loja atendida em até 40 minutos após a ausência ser confirmada.`,
  }),
  { origem: "manual" },
);
await conhecimento.atualizarRegistro(ctx, eu, pop.id, {
  conteudo: pop.conteudo,
  motivo: "Prazo de aviso à loja mudou para 8h30",
});

const pol = await conhecimento.criarRegistro(
  ctx,
  eu,
  novo({
    tipo: "politica",
    titulo: "Multa por atraso",
    area: "financeiro",
    publicar: true,
    relacoes: [],
    conteudo: `## Regra
A multa ao profissional só se aplica quando a ausência **não foi avisada** com pelo menos 1 hora de antecedência.

## A quem se aplica
Todos os profissionais em escala fixa.

## Exceções
Problemas mecânicos comprovados com foto no grupo da praça.`,
  }),
  { origem: "manual" },
);
await conhecimento.criarRegistro(
  ctx,
  eu,
  novo({
    tipo: "ocorrencia",
    titulo: "Falta recorrente no primeiro turno",
    publicar: true,
    relacoes: [{ destinoId: pop.id, tipo: "referencia" }],
    conteudo: "## O que aconteceu\nTrês faltas na mesma semana no primeiro turno de Salvador.\n\n## O que fizemos\nAplicamos o POP de troca em rota e o cliente entrou na lista de alocação fixa.",
  }),
  { origem: "manual" },
);
await conhecimento.criarRegistro(
  ctx,
  eu,
  novo({
    tipo: "cliente",
    titulo: "Autopeças Exemplo",
    clienteRef: "Autopeças Exemplo",
    area: "comercial",
    publicar: true,
    conteudo: "## Resumo do cliente\nCliente de exemplo para a demonstração.\n\n## SLA e combinados\nColeta até 9h; entrega no mesmo dia.",
  }),
  { origem: "manual" },
);
await conhecimento.criarRegistro(
  ctx,
  supervisor,
  novo({ tipo: "pop", titulo: "Coleta em loja fechada", conteudo: "## Passos\n1. Ligar para o contato da loja.\n2. Aguardar até 15 minutos.\n3. Registrar a tentativa na Central." }),
  { origem: "manual" },
);
const claude = await conhecimento.criarRegistro(
  ctx,
  { ...eu, canal: "mcp" },
  novo({
    tipo: "decisao",
    titulo: "Nova regra de multa por atraso",
    area: "financeiro",
    relacoes: [{ destinoId: pol.id, tipo: "substitui" }],
    conteudo: "## Decisão\nMulta só quando a ausência não foi avisada.\n\n## Contexto\nDiscutido numa conversa sobre o aumento de faltas em outubro.",
  }),
  { origem: "claude", sempreRascunho: true },
);
void claude;

// Reunião gravada → ata (rascunho) para revisar.
const reuniao = await fontes.registrarReuniao(ctx, {
  externoId: "demo-1",
  titulo: "Alinhamento semanal de supervisores",
  inicio: new Date(Date.now() - 2 * 3600_000),
  duracaoSeg: 2520,
  url: "https://fathom.video/share/demo",
  transcricao: "Supervisor: precisamos padronizar o aviso à loja.\nCEO: antes das 8h30, sempre.",
});
await fontes.gerarAta(ctx, reuniao.id!);

// Um POP vencido para a seção "Precisam de atenção".
await pool.query(`UPDATE cerebro.registros SET revisar_em = current_date - 3 WHERE id = $1`, [pop.id]);
await pool.query(`UPDATE cerebro.registros SET revisar_em = current_date + 5 WHERE id = $1`, [pol.id]);
await conhecimento.marcarVencidos(ctx);

await pool.query(`INSERT INTO cerebro.lacunas (pergunta, canal) VALUES ($1, 'web'), ($2, 'mcp')`, [
  "Quanto tempo antes a loja precisa ser avisada nos fins de semana?",
  "Qual o valor do km rodado para entregas acima de 30 km?",
]);
await integracoes.salvar(pool, "notion", { config: { databaseId: "demo", propTitulo: "Nome" } });

// Indexa tudo (sem embeddings no demo: só busca por texto).
for (let job = await jobs.reservar(pool); job; job = await jobs.reservar(pool)) {
  if (job.tipo === "indexar_registro") await indexarRegistro(ctx, job.payload.registroId as string);
  await jobs.concluir(pool, job.id);
}
await pool.end();
console.log("Demo pronto. Entre com admin@tutts.com.br / cerebro12345");
