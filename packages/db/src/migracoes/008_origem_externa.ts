/* eslint-disable */
// Migration 008 — outros sistemas da empresa (ex.: Prospect Team).
// Registros que chegam deles (sempre rascunho) e tokens só para sistema: o token do Prospect Team
// não abre o conector do Claude (que lê a Central), e o do Claude não abre a API externa.
export default String.raw`
ALTER TABLE cerebro.registros DROP CONSTRAINT IF EXISTS registros_origem_check;
ALTER TABLE cerebro.registros ADD CONSTRAINT registros_origem_check
  CHECK (origem IN ('manual','claude','reuniao','importacao','email','upload','externo'));

ALTER TABLE cerebro.tokens_conector
  ADD COLUMN uso text NOT NULL DEFAULT 'claude' CHECK (uso IN ('claude', 'sistema'));
`;
