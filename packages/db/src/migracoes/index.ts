import m001 from "./001_inicial.js";
import m002 from "./002_tarefas.js";
import m003 from "./003_documentos.js";
import m004 from "./004_emails.js";

/**
 * Migrations em ordem. Ficam em TypeScript para irem junto no bundle de cada app.
 * Para criar uma nova: adicione `NNN_nome.ts` e registre aqui, no fim da lista.
 */
export const MIGRACOES: { nome: string; sql: string }[] = [
  { nome: "001_inicial", sql: m001 },
  { nome: "002_tarefas", sql: m002 },
  { nome: "003_documentos", sql: m003 },
  { nome: "004_emails", sql: m004 },
];
