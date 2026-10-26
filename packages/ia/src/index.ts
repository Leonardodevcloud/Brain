export { mascarar, restaurar, type OpcoesMascara, type ResultadoMascara } from "./mascara.js";
export { dividirEmTrechos, cosseno, normalizar, fusaoRRF } from "./texto.js";
export {
  ProvedorCompativelOpenAI,
  EmbeddingsGemini,
  lerJson,
  type Mensagem,
  type PedidoTexto,
  type ProvedorTexto,
  type ProvedorEmbeddings,
  type TipoEmbedding,
} from "./provedores.js";
export * from "./prompts.js";
export { palavras, vetoresTfIdf, cossenoEsparso, vizinhosMaisProximos, mediaVetores } from "./semelhanca.js";
export {
  FalaCompativelOpenAI,
  TranscricaoCompativelOpenAI,
  VOZES_FALA,
  textoParaFala,
  lerTranscricao,
  MARCA_INCERTA,
  type ProvedorFala,
  type ProvedorTranscricao,
  type VozFala,
} from "./voz.js";
