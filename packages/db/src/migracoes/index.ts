import m001 from "./001_inicial.js";
import m002 from "./002_tarefas.js";
import m003 from "./003_documentos.js";
import m004 from "./004_emails.js";
import m005 from "./005_conversas.js";
import m006 from "./006_calculo_margem_767.js";
import m007 from "./007_tarefas_recorrencia.js";

/**
 * Migrations em ordem. Ficam em TypeScript para irem junto no bundle de cada app.
 * Para criar uma nova: adicione `NNN_nome.ts` e registre aqui, no fim da lista.
 */
export const MIGRACOES: { nome: string; sql: string }[] = [
  { nome: "001_inicial", sql: m001 },
  { nome: "002_tarefas", sql: m002 },
  { nome: "003_documentos", sql: m003 },
  { nome: "004_emails", sql: m004 },
  { nome: "005_conversas", sql: m005 },
  { nome: "006_calculo_margem_767", sql: m006 },
  { nome: "007_tarefas_recorrencia", sql: m007 },
];
