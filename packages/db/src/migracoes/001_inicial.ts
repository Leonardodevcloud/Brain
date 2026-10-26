/* eslint-disable */
// Migration 001 — schema inicial do cérebro. Nunca edite uma migration já aplicada: crie a próxima.
export default String.raw`
-- Schema próprio do cérebro, no mesmo Postgres da Central Tutts.
-- Nada aqui altera tabelas da Central; dados dela entram só por views (migrations futuras).

CREATE SCHEMA IF NOT EXISTS cerebro;

-- ─────────────────────────── Pessoas e acesso ───────────────────────────

CREATE TABLE cerebro.usuarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  email         text NOT NULL,
  senha_hash    text NOT NULL,
  papel         text NOT NULL DEFAULT 'membro' CHECK (papel IN ('admin', 'membro')),
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX usuarios_email_unico ON cerebro.usuarios (lower(email));

-- Refresh tokens: guardamos só o hash.
CREATE TABLE cerebro.sessoes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid NOT NULL REFERENCES cerebro.usuarios (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expira_em   timestamptz NOT NULL,
  revogada_em timestamptz,
  user_agent  text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessoes_usuario ON cerebro.sessoes (usuario_id);

-- Tokens pessoais usados pelo conector do Claude (MCP).
CREATE TABLE cerebro.tokens_conector (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id    uuid NOT NULL REFERENCES cerebro.usuarios (id) ON DELETE CASCADE,
  nome          text NOT NULL,
  prefixo       text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  ultimo_uso_em timestamptz,
  revogado_em   timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── Conhecimento ───────────────────────────

CREATE TABLE cerebro.sequencias_codigo (
  tipo    text PRIMARY KEY,
  proximo integer NOT NULL DEFAULT 1
);

CREATE TABLE cerebro.registros (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo            text NOT NULL UNIQUE,
  tipo              text NOT NULL CHECK (tipo IN ('pop','decisao','ocorrencia','politica','cliente','sistema','indicador','reuniao','nota')),
  titulo            text NOT NULL,
  conteudo          text NOT NULL,
  area              text NOT NULL DEFAULT 'operacoes',
  empresa           text NOT NULL DEFAULT 'todas',
  status            text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','vigente','revisar','obsoleto','descartado')),
  confidencialidade text NOT NULL DEFAULT 'interno' CHECK (confidencialidade IN ('interno','restrito')),
  dono_id           uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  revisar_em        date,
  versao            integer NOT NULL DEFAULT 1,
  origem            text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','claude','reuniao','importacao','email')),
  fonte_url         text,
  cliente_ref       text,
  dados             jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_por        uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  busca             tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('portuguese', coalesce(titulo, '')), 'A') ||
                      setweight(to_tsvector('portuguese', coalesce(cliente_ref, '')), 'B') ||
                      setweight(to_tsvector('portuguese', coalesce(conteudo, '')), 'C')
                    ) STORED
);
CREATE INDEX registros_busca ON cerebro.registros USING gin (busca);
CREATE INDEX registros_status ON cerebro.registros (status, tipo);
CREATE INDEX registros_revisar_em ON cerebro.registros (revisar_em) WHERE status = 'vigente';
-- Evita importar a mesma origem duas vezes (conversa do Claude, reunião, e-mail).
CREATE UNIQUE INDEX registros_origem_externa ON cerebro.registros ((dados ->> 'origemExternaId'))
  WHERE dados ? 'origemExternaId';

CREATE TABLE cerebro.registro_versoes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  versao      integer NOT NULL,
  titulo      text NOT NULL,
  conteudo    text NOT NULL,
  metadados   jsonb NOT NULL DEFAULT '{}'::jsonb,
  motivo      text NOT NULL,
  autor_id    uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registro_id, versao)
);

CREATE TABLE cerebro.relacoes (
  origem_id  uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  destino_id uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  tipo       text NOT NULL CHECK (tipo IN ('referencia','implementa','substitui','contradiz')),
  criado_em  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origem_id, destino_id, tipo),
  CHECK (origem_id <> destino_id)
);
CREATE INDEX relacoes_destino ON cerebro.relacoes (destino_id);

-- Trechos indexados para a busca semântica.
-- "embedding real[]" funciona em qualquer Postgres; com pgvector, uma migration futura troca o tipo.
CREATE TABLE cerebro.trechos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registro_id uuid NOT NULL REFERENCES cerebro.registros (id) ON DELETE CASCADE,
  ordem       integer NOT NULL,
  texto       text NOT NULL,
  embedding   real[],
  modelo      text,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registro_id, ordem)
);

-- Perguntas que o cérebro não soube responder: viram a fila de documentação.
CREATE TABLE cerebro.lacunas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pergunta     text NOT NULL,
  usuario_id   uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  canal        text NOT NULL DEFAULT 'web',
  resolvida_em timestamptz,
  registro_id  uuid REFERENCES cerebro.registros (id) ON DELETE SET NULL,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── Fontes externas ───────────────────────────

CREATE TABLE cerebro.reunioes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origem       text NOT NULL DEFAULT 'fathom',
  externo_id   text NOT NULL,
  titulo       text NOT NULL,
  inicio       timestamptz,
  duracao_seg  integer,
  url          text,
  transcricao  text NOT NULL,
  ata_id       uuid REFERENCES cerebro.registros (id) ON DELETE SET NULL,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origem, externo_id)
);

-- Conversas do Claude e e-mails já avaliados, relevantes ou não: não pagam IA duas vezes.
CREATE TABLE cerebro.fontes_processadas (
  chave         text PRIMARY KEY,
  resultado     text NOT NULL CHECK (resultado IN ('registro', 'irrelevante', 'erro')),
  registro_id   uuid REFERENCES cerebro.registros (id) ON DELETE SET NULL,
  processado_em timestamptz NOT NULL DEFAULT now()
);

-- Credenciais e configurações das integrações (segredos cifrados com AES-GCM).
CREATE TABLE cerebro.integracoes (
  nome          text PRIMARY KEY,
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  segredo       text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── Infra interna ───────────────────────────

-- Fila de jobs do worker: "FOR UPDATE SKIP LOCKED", sem Redis.
CREATE TABLE cerebro.jobs (
  id             bigserial PRIMARY KEY,
  tipo           text NOT NULL,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  chave          text,
  status         text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','executando','concluido','falhou')),
  tentativas     integer NOT NULL DEFAULT 0,
  max_tentativas integer NOT NULL DEFAULT 5,
  executar_em    timestamptz NOT NULL DEFAULT now(),
  erro           text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_fila ON cerebro.jobs (executar_em) WHERE status = 'pendente';
-- Um job pendente por chave (ex.: reindexar o mesmo registro duas vezes seguidas).
CREATE UNIQUE INDEX jobs_chave_pendente ON cerebro.jobs (chave) WHERE status = 'pendente' AND chave IS NOT NULL;

CREATE TABLE cerebro.auditoria (
  id          bigserial PRIMARY KEY,
  usuario_id  uuid REFERENCES cerebro.usuarios (id) ON DELETE SET NULL,
  canal       text NOT NULL DEFAULT 'web',
  acao        text NOT NULL,
  entidade    text,
  entidade_id text,
  detalhes    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auditoria_recente ON cerebro.auditoria (criado_em DESC);
`;
