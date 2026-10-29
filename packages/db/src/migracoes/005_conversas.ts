/* eslint-disable */
// Migration 005 — conversas com o Argos, guardadas por pessoa (lista da tela Perguntar).
// Cada conversa guarda as trocas como JSON (pergunta + resposta exibida); só o dono enxerga.
export default String.raw`
CREATE TABLE cerebro.conversas (
  id            uuid PRIMARY KEY,
  usuario_id    uuid NOT NULL REFERENCES cerebro.usuarios (id) ON DELETE CASCADE,
  titulo        text NOT NULL DEFAULT '',
  turnos        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Texto corrido das perguntas e respostas, para a busca da lista.
  texto         text NOT NULL DEFAULT '',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversas_usuario ON cerebro.conversas (usuario_id, atualizado_em DESC);
`;
