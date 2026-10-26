import { cosseno } from "./texto.js";

// Palavras que aparecem em quase todo texto e não dizem nada sobre o assunto.
const VAZIAS = new Set(
  (
    "para pela pelo pelos pelas como mais menos quando onde quem qual quais esse essa este esta isso isto aquele aquela " +
    "deve devem pode podem sempre nunca entre sobre após antes depois ainda também muito muita muitos muitas cada " +
    "todo toda todos todas outro outra outros outras mesmo mesma seja sejam será serão está estão foram sido tendo " +
    "fazer feito feita caso casos assim então porque objetivo passos quando usar exceções indicador sucesso resumo"
  ).split(" "),
);

/** Palavras significativas de um texto, sem acento e em minúsculas. */
export function palavras(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 4 && !VAZIAS.has(p) && !/^\d+$/.test(p));
}

/**
 * Vetores TF-IDF esparsos, para medir semelhança quando não há embeddings.
 * Palavras raras no acervo pesam mais que as comuns.
 */
export function vetoresTfIdf(textos: string[]): Map<string, number>[] {
  const contagens = textos.map((t) => {
    const c = new Map<string, number>();
    for (const p of palavras(t)) c.set(p, (c.get(p) ?? 0) + 1);
    return c;
  });
  const documentos = new Map<string, number>();
  for (const c of contagens) for (const p of c.keys()) documentos.set(p, (documentos.get(p) ?? 0) + 1);
  const n = textos.length;
  return contagens.map((c) => {
    const v = new Map<string, number>();
    let norma = 0;
    for (const [p, tf] of c) {
      const peso = (1 + Math.log(tf)) * Math.log(1 + n / (documentos.get(p) ?? 1));
      v.set(p, peso);
      norma += peso * peso;
    }
    norma = Math.sqrt(norma) || 1;
    for (const [p, peso] of v) v.set(p, peso / norma);
    return v;
  });
}

export function cossenoEsparso(a: Map<string, number>, b: Map<string, number>): number {
  const [menor, maior] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [p, x] of menor) {
    const y = maior.get(p);
    if (y) s += x * y;
  }
  return s;
}

/**
 * Para cada item, os vizinhos mais parecidos acima do limiar. Pares repetidos saem uma vez,
 * com a maior pontuação. `similaridade(i, j)` recebe índices.
 */
export function vizinhosMaisProximos(
  total: number,
  similaridade: (i: number, j: number) => number,
  { porItem = 3, limiar }: { porItem?: number; limiar: number },
): { a: number; b: number; peso: number }[] {
  const pares = new Map<string, { a: number; b: number; peso: number }>();
  for (let i = 0; i < total; i++) {
    const melhores: { j: number; s: number }[] = [];
    for (let j = 0; j < total; j++) {
      if (i === j) continue;
      const s = similaridade(i, j);
      if (s < limiar) continue;
      melhores.push({ j, s });
    }
    melhores.sort((x, y) => y.s - x.s);
    for (const { j, s } of melhores.slice(0, porItem)) {
      const chave = i < j ? `${i}:${j}` : `${j}:${i}`;
      const atual = pares.get(chave);
      if (!atual || atual.peso < s) pares.set(chave, { a: Math.min(i, j), b: Math.max(i, j), peso: s });
    }
  }
  return [...pares.values()];
}

/** Média de vários vetores densos (os trechos de um mesmo registro). */
export function mediaVetores(vetores: number[][]): number[] {
  const n = vetores[0]?.length ?? 0;
  const soma = new Array<number>(n).fill(0);
  for (const v of vetores) for (let i = 0; i < n; i++) soma[i]! += v[i] ?? 0;
  return soma.map((x) => x / vetores.length);
}

export { cosseno };
