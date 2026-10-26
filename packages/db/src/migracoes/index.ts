import m001 from "./001_inicial.js";

/**
 * Migrations em ordem. Ficam em TypeScript para irem junto no bundle de cada app.
 * Para criar uma nova: adicione `NNN_nome.ts` e registre aqui, no fim da lista.
 */
export const MIGRACOES: { nome: string; sql: string }[] = [{ nome: "001_inicial", sql: m001 }];
