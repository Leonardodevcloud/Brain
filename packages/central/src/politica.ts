/**
 * O que o Argos NÃO pode ler na Central. Decidido com o dono: financeiro, BI e operação
 * liberados; dados pessoais sensíveis, credenciais e conversas privadas, não.
 */

/** Tabelas fora por inteiro: credenciais, sessões, mensagens privadas, documentos e pesquisas internas. */
export const TABELAS_BLOQUEADAS = new Set([
  "refresh_tokens",
  "password_recovery",
  "login_attempts",
  "blocked_accounts",
  "logistics_oauth_tokens",
  "push_subscriptions",
  "user_financial_data",
  "social_messages",
  "social_profiles",
  "social_status",
  "bi_chat_conversas",
  "bi_chat_mensagens",
  "bi_chat_memorias",
  "rh_nps_sensivel",
  "rh_nps_respostas",
  "moto_documentos",
  "moto_docs_veiculo",
  "moto_arquivos",
  "moto_locatario_acessos",
  "sinistro_evidencias",
  "foto_hashes",
  "foto_crash_logs",
  "audit_logs",
  "solicitacao_idempotency",
  "withdrawal_idempotency",
]);

// Partes de nome de coluna que indicam dado pessoal ou credencial ("pix_key", "senha_hash", "cpf"...).
const PARTES_PESSOAIS = new Set([
  "cpf",
  "rg",
  "cnh",
  "pix",
  "banco",
  "agencia",
  "conta",
  "senha",
  "password",
  "passwd",
  "hash",
  "salt",
  "token",
  "secret",
  "segredo",
  "apikey",
  "renavam",
  "chassi",
  "placa",
  "nascimento",
  "biometria",
  "selfie",
]);
const COMBINACOES_PESSOAIS = [/api_?key/, /chave_(pix|api|acesso)/, /private_?key/];

/** A coluna sai das views do Argos? */
export function ehColunaPessoal(coluna: string): boolean {
  const nome = coluna.toLowerCase();
  if (COMBINACOES_PESSOAIS.some((r) => r.test(nome))) return true;
  return nome.split(/[^a-z0-9]+/).some((parte) => PARTES_PESSOAIS.has(parte));
}

export function tabelaLiberada(tabela: string): boolean {
  return !TABELAS_BLOQUEADAS.has(tabela) && !tabela.startsWith("pg_") && !tabela.startsWith("_");
}

/** Nome do schema com as views que o Argos enxerga, e do usuário somente leitura. */
export const SCHEMA_ARGOS = "argos";
export const PAPEL_LEITURA = "argos_leitura";
