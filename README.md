# Cérebro · Central Tutts

Segundo cérebro da operação: POPs, decisões, políticas, fichas de clientes e atas num só lugar,
consultável pela interface e pelo Claude, alimentado por reuniões (Fathom), conversas do Claude e e-mail.

## Arquitetura

```
apps/
  web/      React + Vite. Em produção, servidor.mjs entrega o build e faz proxy de /api e /mcp
  api/      Express 5 — login próprio, registros, perguntas, integrações, webhook da Fathom
  mcp/      Servidor MCP (Streamable HTTP) para o conector do Claude
  worker/   Fila no Postgres (atas, indexação, Notion, extração) + rotinas agendadas
packages/
  core/         Tipos, constantes e validação (zod). `@cerebro/core/publico` é a versão sem zod, para a web
  db/           Conexão, migrations (schema `cerebro`) e repositórios — SQL sempre parametrizado
  auth/         Senhas (bcrypt), JWT de acesso, tokens opacos, cofre AES-256-GCM
  ia/           DeepSeek (API compatível com OpenAI), embeddings Gemini, máscara de dados pessoais, prompts
  integracoes/  Fathom, Notion, Google Agenda, IMAP, exportação do Claude
  servicos/     Regras de negócio. API, MCP e worker são só "portas" para esta camada
```

Tudo fica numa só origem (`https://cerebro…/`): a interface, `/api/*` e `/mcp/*`.
Por isso não há CORS e o cookie de sessão é `httpOnly; SameSite=Strict; Path=/api/auth`.

**Regras que valem em todo o código**
- Nada vira vigente sem aprovação. IA, Claude, e-mail e reuniões só criam rascunhos.
- Políticas e decisões são aprovadas e editadas só pelo administrador.
- Toda edição gera versão com motivo. Toda ação relevante vai para `cerebro.auditoria`.
- Conteúdo `restrito` nunca vai para IA externa nem para o Claude.
- Dados pessoais (CPF, CNPJ, telefone, PIX, placa, e-mail, conta) são mascarados antes de ir para a IA.

## Rodar localmente

Requisitos: Node 22+, pnpm 10 (`corepack enable`), Postgres 16.

```bash
pnpm install
cp .env.example .env          # preencha JWT_SEGREDO e CEREBRO_CHAVE_CIFRA
pnpm db:migrar
pnpm --filter @cerebro/api demo   # opcional: dados de exemplo (só em banco local)
pnpm dev                          # web :5173 · api :3000 · mcp :3001 · worker
```

Demo: `admin@tutts.com.br` / `cerebro12345`.

Testes (usam um banco real, `DATABASE_URL_TESTE`, padrão `postgres://cerebro:cerebro@localhost:5432/cerebro_teste`):

```bash
pnpm typecheck && pnpm test && pnpm build
```

## Deploy no Railway

Um projeto, o Postgres que já existe e **quatro serviços apontando para este mesmo repositório**
(Root Directory vazio). A configuração é feita no painel de cada serviço, em Settings — o "config as code"
(`railway.json`) foi descontinuado pelo Railway para serviços novos.

| Serviço | Build Command | Start Command | Healthcheck | Domínio |
|---|---|---|---|---|
| `api` | `pnpm turbo run build --filter=@cerebro/api` | `pnpm --filter @cerebro/api start` | `/api/saude` | não |
| `mcp` | `pnpm turbo run build --filter=@cerebro/mcp` | `pnpm --filter @cerebro/mcp start` | `/saude` | não |
| `worker` | `pnpm turbo run build --filter=@cerebro/worker` | `pnpm --filter @cerebro/worker start` | — | não |
| `web` | `pnpm turbo run build --filter=@cerebro/web` | `pnpm --filter @cerebro/web start` | `/` | **sim** |

Shared Variables (em `api`, `mcp`, `worker`): `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `DATABASE_SSL=false`,
`NODE_ENV=production`, `URL_WEB=https://<domínio>`, `URL_API=https://<domínio>/api`, `JWT_SEGREDO`,
`CEREBRO_CHAVE_CIFRA`, `CONFIAR_PROXY=2`. Por serviço: `api` → `PORT=3000`; `mcp` → `PORT=3001`; `web` →
```
API_INTERNA_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
MCP_INTERNA_URL=http://${{mcp.RAILWAY_PRIVATE_DOMAIN}}:${{mcp.PORT}}
```

A API aplica as migrations ao subir (o worker também confere; há trava no banco).
O schema `cerebro` fica separado das tabelas da Central — nada da Central é alterado.

Primeiro administrador (uma vez, com a `DATABASE_URL` pública do Postgres):
```bash
DATABASE_URL=<url-publica> DATABASE_SSL=true pnpm db:admin --nome "Seu Nome" --email voce@tutts.com.br
```
As demais pessoas são criadas na tela **Sua conta › Equipe**.

## Integrações

**Claude (conector).** Integrações › Conector do Claude › Gerar endereço. No Claude: Customize › Connectors ›
Add custom connector, URL `https://<domínio>/mcp`, "No sign in" e o cabeçalho `Authorization: Bearer cbr_…`
(alternativa sem cabeçalho: `https://<domínio>/mcp/cbr_…`).
Ferramentas: `buscar_conhecimento`, `ler_registro`, `listar_pendencias`, `salvar_rascunho`.
O token vale como senha: revogue na mesma tela.

**Histórico do Claude.** Exportar dados no Claude e enviar o `.zip` em Integrações. Só conversas novas são analisadas.

**Fathom.** User Settings › API Access › Manage › Add Webhook para `https://<domínio>/api/webhooks/fathom` com a transcrição.
Cole o segredo `whsec_…` em `FATHOM_WEBHOOK_SEGREDO`. A assinatura é verificada (Standard Webhooks).
O formato do payload deve ser conferido com a primeira reunião real (o leitor é tolerante e ignora o que não reconhece).

**Google Agenda.** Google Cloud › OAuth (app em produção, escopo `calendar.events.readonly`), redirect
`https://<domínio>/api/integracoes/google/retorno`. Preencha `GOOGLE_CLIENT_ID/SECRET` e clique em Conectar.

**Notion.** Crie uma integração interna, copie o token para `NOTION_TOKEN`, conecte-a ao banco de tarefas
(••• › Conexões) e, em Integrações › Notion, cole o link do banco e escolha as colunas.

**E-mail.** Caixa dedicada (ex.: `cerebro@tutts.com.br`) com IMAP 993/SSL. Variáveis `IMAP_*`.
O worker lê a cada 10 minutos; cada e-mail relevante vira rascunho.
