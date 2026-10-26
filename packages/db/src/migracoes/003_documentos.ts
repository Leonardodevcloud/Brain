/* eslint-disable */
// Migration 003 — documentos enviados (PDF, Word, planilhas, texto) como conhecimento do Cérebro.
export default String.raw`
ALTER TABLE cerebro.registros DROP CONSTRAINT IF EXISTS registros_tipo_check;
ALTER TABLE cerebro.registros ADD CONSTRAINT registros_tipo_check
  CHECK (tipo IN ('pop','decisao','ocorrencia','politica','cliente','sistema','indicador','reuniao','nota','documento'));

ALTER TABLE cerebro.registros DROP CONSTRAINT IF EXISTS registros_origem_check;
ALTER TABLE cerebro.registros ADD CONSTRAINT registros_origem_check
  CHECK (origem IN ('manual','claude','reuniao','importacao','email','upload'));

-- O arquivo original fica guardado para baixar; o texto extraído vira o conteúdo do registro.
CREATE TABLE cerebro.arquivos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  nome        text NOT NULL,
  mime        text NOT NULL,
  tamanho     integer NOT NULL,
  sha256      text NOT NULL,
  conteudo    bytea NOT NULL,
  criado_por  uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arquivos_registro ON cerebro.arquivos (registro_id);
-- O mesmo arquivo não entra duas vezes.
CREATE UNIQUE INDEX arquivos_sha ON cerebro.arquivos (sha256);
`;
