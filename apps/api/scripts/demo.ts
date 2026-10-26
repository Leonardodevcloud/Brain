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

// Acervo maior, para o Mapa ter o que mostrar: [tipo, área, título, cliente, conteúdo].
type Semente = [CriarRegistro["tipo"], CriarRegistro["area"], string, string | null, string];
const ACERVO: Semente[] = [
  ["pop", "operacoes", "Abertura do turno da manhã", null, "Conferir escala de motoboys, confirmar presença no grupo da praça e liberar as primeiras coletas até 7h30."],
  ["pop", "operacoes", "Coleta de peça em garantia", null, "Retirar a peça em garantia na loja, conferir nota fiscal e etiqueta, fotografar a embalagem e entregar no fornecedor."],
  ["pop", "operacoes", "Entrega com cliente ausente", null, "Ligar para o cliente, aguardar 10 minutos, registrar tentativa de entrega com foto e devolver a peça para a loja."],
  ["pop", "operacoes", "Avaria de peça no transporte", null, "Fotografar a avaria, abrir ocorrência na Central, avisar a loja e o supervisor da praça antes de devolver a peça."],
  ["pop", "operacoes", "Roteirização de entregas em lote", null, "Agrupar entregas por região no roteirizador, respeitar a janela de cada loja e liberar a rota para o motoboy."],
  ["pop", "operacoes", "Fechamento do turno", null, "Conferir entregas pendentes, devolver peças não entregues e registrar o fechamento do turno na Central."],
  ["ocorrencia", "operacoes", "Atraso em coleta na loja Centro", "Autopeças Exemplo", "Motoboy chegou 40 minutos depois da janela de coleta. Causa: troca de motoboy em rota sem aviso à loja."],
  ["ocorrencia", "operacoes", "Peça trocada na entrega", "Rede Exemplo Norte", "Peça entregue no endereço errado por troca de etiqueta na coleta. Reforçado o POP de conferência de etiqueta."],
  ["ocorrencia", "atendimento", "Reclamação de motoboy sem uniforme", "Rede Exemplo Norte", "Loja reclamou de motoboy sem colete e sem crachá. Supervisor orientou o profissional e registrou advertência."],
  ["cliente", "comercial", "Rede Exemplo Norte", "Rede Exemplo Norte", "Rede com 6 lojas. SLA de coleta em 30 minutos, alocação fixa de 2 motoboys pela manhã, faturamento quinzenal."],
  ["cliente", "comercial", "Distribuidora Exemplo Sul", "Distribuidora Exemplo Sul", "Distribuidora com entregas em lote no fim da tarde. Roteirização obrigatória e janela de entrega até 18h."],
  ["decisao", "comercial", "Alocação fixa para a Rede Exemplo Norte", "Rede Exemplo Norte", "Dois motoboys fixos pela manhã na Rede Exemplo Norte, com substituto aprovado pelo CEO em caso de falta."],
  ["politica", "comercial", "Tabela de preço por faixa de km", null, "Valor base por faixa de km rodado, acréscimo por entrega em lote acima de 30 km e cobrança de espera após 15 minutos."],
  ["decisao", "comercial", "Cobrança de espera após 15 minutos", null, "Espera na loja acima de 15 minutos passa a ser cobrada por faixa, conforme a tabela de preço por km."],
  ["politica", "financeiro", "Saque semanal dos profissionais", null, "Saque liberado toda sexta pela Plific, com conferência de entregas da semana e desconto de multas aplicadas."],
  ["pop", "financeiro", "Conferência de saques na Plific", null, "Exportar entregas da semana, conferir valor por profissional, aplicar descontos de multa e aprovar o saque na Plific."],
  ["pop", "financeiro", "Faturamento quinzenal de clientes", null, "Gerar o relatório de entregas por cliente, conferir SLA e espera cobrada, emitir nota e enviar o faturamento."],
  ["indicador", "financeiro", "Custo por entrega", null, "Custo total da operação dividido pelo número de entregas no mês. Meta: abaixo da tabela de preço por km."],
  ["indicador", "operacoes", "SLA de coleta por cliente", null, "Percentual de coletas feitas dentro da janela combinada com cada cliente. Meta: 95% no mês."],
  ["indicador", "operacoes", "Taxa de falta de motoboy", null, "Faltas não avisadas dividido pelo total de escalas do mês. Usado na regra de multa por atraso."],
  ["sistema", "tecnologia", "Central Tutts — módulo de solicitações", null, "Onde a loja pede ajuste de entrega. Erro comum: solicitação sem endereço completo trava a roteirização."],
  ["sistema", "tecnologia", "Roteirizador", null, "Agrupa entregas por região com o OpenRouteService. Se o geocoding falhar, corrigir o endereço na Central."],
  ["sistema", "tecnologia", "Agente de correção de endereços", null, "Automação que corrige endereços no sistema legado. Verificar a fila do agente quando a roteirização falhar."],
  ["pop", "tecnologia", "Endereço que não geocodifica", null, "Conferir CEP e número, corrigir na Central, acionar o agente de correção de endereços e roteirizar de novo."],
  ["pop", "pessoas", "Recrutamento de motoboy", null, "Divulgar a vaga, aplicar o teste DISC, conferir documentos da moto e agendar integração com o supervisor."],
  ["pop", "pessoas", "Integração de novo motoboy", null, "Apresentar os POPs de coleta e entrega, uniforme e colete, uso do aplicativo e a regra de multa por atraso."],
  ["politica", "pessoas", "Uniforme e identificação", null, "Colete e crachá obrigatórios em toda coleta e entrega. Sem uniforme, o motoboy não inicia o turno."],
  ["decisao", "pessoas", "Bônus mensal de supervisores", null, "Bônus por SLA de coleta acima de 95% e taxa de falta abaixo de 3% na praça do supervisor."],
  ["pop", "marketing", "Post de recrutamento nas redes", null, "Publicar a vaga de motoboy com a arte padrão, regiões com vaga aberta e link da página de recrutamento."],
  ["nota", "marketing", "Ideias de conteúdo para lojistas", null, "Mostrar o SLA de coleta, casos de entrega rápida e o processo de garantia como diferencial para lojas."],
  ["pop", "atendimento", "Atendimento de reclamação de loja", null, "Ouvir a loja, registrar a ocorrência na Central, dar prazo de retorno e avisar o supervisor da praça."],
  ["pop", "atendimento", "Retorno ao cliente após ocorrência", null, "Retornar à loja com a causa da ocorrência, o que foi feito e como evitar, em até 24 horas."],
  ["decisao", "gestao", "Reunião semanal de supervisores", null, "Toda segunda às 14h, pauta: faltas, ocorrências da semana, SLA por cliente e lacunas do Cérebro."],
  ["nota", "gestao", "Prioridades do trimestre", null, "Reduzir a taxa de falta de motoboy, subir o SLA de coleta e documentar os POPs que mais geram dúvida."],
  ["politica", "gestao", "Aprovação de exceções pelo CEO", null, "Substituto em alocação fixa, desconto de tabela e multa fora da regra precisam de aprovação do CEO."],
];

const criados = new Map<string, string>();
for (const [tipo, area, titulo, cliente, conteudo] of ACERVO) {
  const r = await conhecimento.criarRegistro(
    ctx,
    eu,
    novo({ tipo, area, titulo, clienteRef: cliente, conteudo, publicar: !titulo.startsWith("Ideias") }),
    { origem: "manual" },
  );
  criados.set(titulo, r.id);
}
const ligar = async (de: string, para: string, tipo: "referencia" | "implementa" | "substitui" | "contradiz") => {
  const a = criados.get(de) ?? (de === "POP-001" ? pop.id : de === "POL-001" ? pol.id : undefined);
  const b = criados.get(para) ?? (para === "POP-001" ? pop.id : para === "POL-001" ? pol.id : undefined);
  if (a && b) await pool.query(`INSERT INTO cerebro.relacoes (origem_id, destino_id, tipo) VALUES ($1, $2, $3)`, [a, b, tipo]);
};
await ligar("Alocação fixa para a Rede Exemplo Norte", "Rede Exemplo Norte", "implementa");
await ligar("Cobrança de espera após 15 minutos", "Tabela de preço por faixa de km", "implementa");
await ligar("Conferência de saques na Plific", "Saque semanal dos profissionais", "implementa");
await ligar("Saque semanal dos profissionais", "POL-001", "referencia");
await ligar("Endereço que não geocodifica", "Agente de correção de endereços", "referencia");
await ligar("Roteirização de entregas em lote", "Roteirizador", "referencia");
await ligar("Integração de novo motoboy", "Uniforme e identificação", "referencia");
await ligar("Reclamação de motoboy sem uniforme", "Uniforme e identificação", "referencia");
await ligar("Atraso em coleta na loja Centro", "POP-001", "referencia");
await ligar("Bônus mensal de supervisores", "SLA de coleta por cliente", "referencia");
await ligar("Bônus mensal de supervisores", "Taxa de falta de motoboy", "referencia");
await ligar("Taxa de falta de motoboy", "POL-001", "referencia");
await ligar("Atendimento de reclamação de loja", "Retorno ao cliente após ocorrência", "referencia");
await ligar("Aprovação de exceções pelo CEO", "Alocação fixa para a Rede Exemplo Norte", "referencia");
await ligar("Faturamento quinzenal de clientes", "Cobrança de espera após 15 minutos", "referencia");

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

// Indexa tudo (sem embeddings no demo: só busca por texto).
for (let job = await jobs.reservar(pool); job; job = await jobs.reservar(pool)) {
  if (job.tipo === "indexar_registro") await indexarRegistro(ctx, job.payload.registroId as string);
  await jobs.concluir(pool, job.id);
}
await pool.end();
console.log("Demo pronto. Entre com admin@tutts.com.br / cerebro12345");
