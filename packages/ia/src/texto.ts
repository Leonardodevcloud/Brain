/**
 * Divide um texto em trechos de ~`alvo` caracteres, respeitando parágrafos e frases,
 * com uma pequena sobreposição para não cortar o contexto entre trechos.
 */
export function dividirEmTrechos(texto: string, alvo = 900, sobreposicao = 150): string[] {
  const limpo = texto.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!limpo) return [];
  if (limpo.length <= alvo) return [limpo];

  // Quebra em unidades: parágrafos; parágrafos longos viram frases.
  const unidades: string[] = [];
  for (const paragrafo of limpo.split(/\n\n/)) {
    if (paragrafo.length <= alvo) {
      unidades.push(paragrafo);
      continue;
    }
    const frases = paragrafo.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragrafo];
    for (const frase of frases) {
      // Frase gigante (lista sem pontuação): corta em pedaços fixos.
      for (let i = 0; i < frase.length; i += alvo) unidades.push(frase.slice(i, i + alvo));
    }
  }

  const trechos: string[] = [];
  let atual = "";
  for (const unidade of unidades) {
    if (atual && atual.length + unidade.length + 2 > alvo) {
      trechos.push(atual.trim());
      const cauda = atual.slice(-sobreposicao);
      const inicioPalavra = cauda.indexOf(" ");
      atual = (inicioPalavra >= 0 ? cauda.slice(inicioPalavra + 1) : "") + "\n\n";
    }
    atual += (atual && !atual.endsWith("\n\n") ? "\n\n" : "") + unidade;
  }
  if (atual.trim()) trechos.push(atual.trim());
  return trechos;
}

/** Similaridade de cosseno entre dois vetores do mesmo tamanho. */
export function cosseno(a: readonly number[], b: readonly number[]): number {
  let produto = 0;
  let normaA = 0;
  let normaB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    produto += x * y;
    normaA += x * x;
    normaB += y * y;
  }
  return normaA && normaB ? produto / Math.sqrt(normaA * normaB) : 0;
}

export function normalizar(v: number[]): number[] {
  const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norma ? v.map((x) => x / norma) : v;
}

/**
 * Reciprocal Rank Fusion: junta listas ordenadas (texto e vetor) num único ranking,
 * sem precisar calibrar escalas diferentes de pontuação.
 */
export function fusaoRRF(listas: string[][], k = 60): Map<string, number> {
  const pontos = new Map<string, number>();
  for (const lista of listas) {
    lista.forEach((id, posicao) => pontos.set(id, (pontos.get(id) ?? 0) + 1 / (k + posicao + 1)));
  }
  return pontos;
}
