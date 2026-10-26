/**
 * Troca dados pessoais por marcadores antes de enviar texto a uma IA externa,
 * e desfaz a troca na resposta. O mapa nunca sai do nosso servidor.
 */

interface Regra {
  rotulo: string;
  padrao: RegExp;
}

// A ordem importa: padrões mais específicos primeiro (CNPJ antes de telefone, e-mail antes de tudo).
const REGRAS: Regra[] = [
  { rotulo: "EMAIL", padrao: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { rotulo: "CNPJ", padrao: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g },
  { rotulo: "CPF", padrao: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
  { rotulo: "PIX", padrao: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { rotulo: "TELEFONE", padrao: /(?:\+?55\s?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g },
  { rotulo: "PLACA", padrao: /\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b/g },
  { rotulo: "CONTA", padrao: /\b(?:ag(?:ência|encia)?|conta|c\/c)\s*:?\s*[\d.-]{4,}\b/gi },
];

export interface ResultadoMascara {
  texto: string;
  /** marcador → valor original */
  mapa: Map<string, string>;
}

export interface OpcoesMascara {
  /** Nomes de pessoas a esconder (ex.: profissionais citados), trocados por PESSOA_n. */
  nomes?: string[];
}

const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function mascarar(texto: string, opcoes: OpcoesMascara = {}): ResultadoMascara {
  const mapa = new Map<string, string>();
  const reverso = new Map<string, string>();
  const contadores = new Map<string, number>();

  const marcador = (rotulo: string, valor: string) => {
    const chave = `${rotulo}:${valor.toLowerCase()}`;
    const existente = reverso.get(chave);
    if (existente) return existente;
    const n = (contadores.get(rotulo) ?? 0) + 1;
    contadores.set(rotulo, n);
    const m = `[${rotulo}_${n}]`;
    mapa.set(m, valor);
    reverso.set(chave, m);
    return m;
  };

  let resultado = texto;
  for (const { rotulo, padrao } of REGRAS) {
    resultado = resultado.replace(padrao, (valor) => marcador(rotulo, valor));
  }
  const nomes = [...new Set((opcoes.nomes ?? []).map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  for (const nome of nomes) {
    resultado = resultado.replace(new RegExp(`\\b${escaparRegex(nome)}\\b`, "gi"), (valor) => marcador("PESSOA", valor));
  }
  return { texto: resultado, mapa };
}

/** Desfaz a troca. Marcadores que a IA inventou e não existem no mapa ficam como estão. */
export function restaurar(texto: string, mapa: Map<string, string>): string {
  return texto.replace(/\[[A-Z]+_\d+\]/g, (m) => mapa.get(m) ?? m);
}
