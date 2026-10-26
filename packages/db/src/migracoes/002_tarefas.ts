/* eslint-disable */
// Migration 002 — tarefas do Cérebro (substituem o Notion). Nunca edite uma migration já aplicada: crie a próxima.
export default String.raw`
CREATE TABLE cerebro.tarefas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            text NOT NULL UNIQUE,
  titulo            text NOT NULL CHECK (length(titulo) BETWEEN 2 AND 300),
  descricao         text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'a_fazer' CHECK (status IN ('a_fazer', 'fazendo', 'feita')),
  -- Posição dentro da coluna do quadro (menor = mais acima).
  ordem             double precision NOT NULL DEFAULT 0,
  responsavel_id    uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  -- Quando o responsável não é um usuário do Cérebro ("Supervisão SSA", vindo de uma ata).
  responsavel_texto text,
  prazo             date,
  origem            text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'ata', 'argos', 'claude')),
  -- Registro de onde a tarefa nasceu (a ata, por exemplo).
  origem_registro_id uuid REFERENCES cerebro.registros (id) ON DELETE SET NULL,
  cliente_ref       text,
  -- Reunião do Google Agenda ligada à tarefa.
  evento_id         text,
  evento_titulo     text,
  evento_inicio     timestamptz,
  evento_url        text,
  criado_por        uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  concluida_em      timestamptz
);
CREATE INDEX tarefas_status ON cerebro.tarefas (status, ordem);
CREATE INDEX tarefas_responsavel ON cerebro.tarefas (responsavel_id) WHERE status <> 'feita';
CREATE INDEX tarefas_prazo ON cerebro.tarefas (prazo) WHERE status <> 'feita';
-- Uma pendência de ata vira no máximo uma tarefa (aprovar de novo não duplica).
CREATE UNIQUE INDEX tarefas_da_ata ON cerebro.tarefas (origem_registro_id, titulo) WHERE origem = 'ata';

-- Registros ligados à tarefa (além da origem): POP que vai mudar, regra, ficha de cliente…
CREATE TABLE cerebro.tarefa_registros (
  tarefa_id   uuid NOT NULL REFERENCES cerebro.tarefas (id) ON DELETE CASCADE,
  registro_id uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  PRIMARY KEY (tarefa_id, registro_id)
);
CREATE INDEX tarefa_registros_registro ON cerebro.tarefa_registros (registro_id);

-- O Notion saiu: a configuração antiga não serve mais.
DELETE FROM cerebro.integracoes WHERE nome = 'notion';
DELETE FROM cerebro.jobs WHERE tipo = 'criar_tarefas_notion';
`;
