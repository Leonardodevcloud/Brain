/**
 * Divide o texto falado em trechos: o primeiro curto (sai rápido) e os outros maiores,
 * gerados enquanto o primeiro toca. Usado no servidor (para adiantar o 1º trecho) e na interface.
 */
export function dividirFala(texto: string, primeiro = 90, demais = 240): string[] {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (!limpo) return [];
  const frases = limpo.match(/[^.!?;]+[.!?;]*/g) ?? [limpo];
  const partes: string[] = [];
  let atual = "";
  for (const f of frases) {
    const limite = partes.length === 0 ? primeiro : demais;
    if ((atual + f).length > limite && atual) {
      partes.push(atual.trim());
      atual = "";
    }
    atual += f;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}
