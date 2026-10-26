export { criarPool, emTransacao, type Cliente, type Executor, type Pool, type OpcoesConexao } from "./conexao.js";
export { migrar, type ResultadoMigracao } from "./migrar.js";
export { usuarios, type UsuarioLinha } from "./repositorios/usuarios.js";
export { sessoes, tokensConector, type SessaoLinha, type TokenConectorLinha } from "./repositorios/sessoes.js";
export { registros, type RegistroLinha, type NovoRegistro, type CamposEditaveis } from "./repositorios/registros.js";
export { trechos, type TrechoComVetor, type FiltroBusca } from "./repositorios/trechos.js";
export { jobs, type JobLinha } from "./repositorios/jobs.js";
export {
  auditoria,
  lacunas,
  reunioes,
  integracoes,
  fontesProcessadas,
  type Canal,
  type ReuniaoLinha,
} from "./repositorios/diversos.js";
export { mapa, type NoMapaLinha } from "./repositorios/mapa.js";
export { tarefas, type TarefaLinha, type NovaTarefa, type CamposTarefa, type FiltroTarefas, type StatusTarefa, type OrigemTarefa, type LigacaoTarefa } from "./repositorios/tarefas.js";
export { emails, type EmailLinha, type NovoEmail, type AcaoEmail } from "./repositorios/emails.js";
