/* eslint-disable */
// Migration 004 — e-mails recebidos na caixa do Cérebro ficam guardados para a aba E-mail.
// O resultado da IA (virou registro / irrelevante) continua em fontes_processadas, ligado pela chave.
export default String.raw`
CREATE TABLE cerebro.emails (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave        text NOT NULL UNIQUE,
  remetente    text NOT NULL DEFAULT '',
  assunto      text NOT NULL DEFAULT '',
  recebido_em  timestamptz,
  trecho       text NOT NULL DEFAULT '',
  texto        text NOT NULL DEFAULT '',
  -- Decisão de uma pessoa: ignorar ou transformar em tarefa (a IA não mexe aqui).
  acao         text CHECK (acao IN ('ignorado', 'tarefa', 'registro')),
  acao_por     uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  acao_em      timestamptz,
  tarefa_id    uuid REFERENCES cerebro.tarefas (id) ON DELETE SET NULL,
  registro_id  uuid REFERENCES cerebro.registros (id) ON DELETE SET NULL,
  criado_em    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emails_recebido ON cerebro.emails (coalesce(recebido_em, criado_em) DESC);

-- Tarefas também podem nascer de um e-mail.
ALTER TABLE cerebro.tarefas DROP CONSTRAINT IF EXISTS tarefas_origem_check;
ALTER TABLE cerebro.tarefas ADD CONSTRAINT tarefas_origem_check CHECK (origem IN ('manual', 'ata', 'argos', 'claude', 'email'));
`;
