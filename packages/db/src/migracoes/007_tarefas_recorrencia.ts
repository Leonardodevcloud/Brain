/* eslint-disable */
// Migration 007 — tarefas que se repetem (diária, semanal, quinzenal, mensal).
// Cada repetição é uma tarefa própria (com prazo, status e histórico); todas da mesma série têm o mesmo serie_id.
export default String.raw`
ALTER TABLE cerebro.tarefas
  ADD COLUMN recorrencia text CHECK (recorrencia IN ('diaria', 'semanal', 'quinzenal', 'mensal')),
  ADD COLUMN serie_id uuid;
-- Uma repetição por data dentro da série: o worker rodar duas vezes não duplica.
CREATE UNIQUE INDEX tarefas_serie_prazo ON cerebro.tarefas (serie_id, prazo) WHERE serie_id IS NOT NULL;
`;
