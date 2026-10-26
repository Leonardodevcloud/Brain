/** Voz do Argos com a síntese de fala do próprio navegador (gratuita). */

let vozEscolhida: SpeechSynthesisVoice | null | undefined;
// O Chrome descarta falas cuja referência some da memória (e aí o "fim" nunca chega): guardamos aqui.
let filaAtual: SpeechSynthesisUtterance[] = [];
let sessao = 0;

function escolherVoz(): SpeechSynthesisVoice | null {
  if (vozEscolhida !== undefined) return vozEscolhida;
  const vozes = window.speechSynthesis?.getVoices() ?? [];
  if (!vozes.length) return null; // ainda carregando: tenta de novo na próxima fala
  const pt = vozes.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith("pt"));
  const nota = (v: SpeechSynthesisVoice) =>
    (v.lang.toLowerCase().replace("_", "-") === "pt-br" ? 4 : 0) +
    (/natural|neural|online/i.test(v.name) ? 3 : 0) +
    (/google/i.test(v.name) ? 2 : 0) +
    (/francisca|thalita|luciana|antonio|maria|daniel/i.test(v.name) ? 1 : 0);
  vozEscolhida = pt.sort((a, b) => nota(b) - nota(a))[0] ?? null;
  return vozEscolhida;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.getVoices(); // começa a carregar as vozes cedo
  window.speechSynthesis.onvoiceschanged = () => {
    vozEscolhida = undefined;
  };
}

export const falaSuportada = () => typeof window !== "undefined" && "speechSynthesis" in window;

/**
 * Chamar dentro de um gesto (tecla ou clique): libera a fala no Chrome/Safari,
 * que bloqueiam a voz quando ela começa longe de uma ação da pessoa.
 */
export function desbloquearFala() {
  if (!falaSuportada()) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(u);
  } catch {
    /* sem voz: o Argos segue só com texto */
  }
}

/** Frases curtas: o Chrome corta falas longas no meio (~15 s) e para de responder. */
function dividir(texto: string): string[] {
  const frases = texto.replace(/\s+/g, " ").match(/[^.!?;:]+[.!?;:]*/g) ?? [texto];
  const partes: string[] = [];
  let atual = "";
  for (const f of frases) {
    if ((atual + f).length > 180 && atual) {
      partes.push(atual.trim());
      atual = "";
    }
    atual += f;
  }
  if (atual.trim()) partes.push(atual.trim());
  return partes;
}

export function falar(texto: string, eventos: { aoPalavra?: () => void; aoFim?: () => void } = {}) {
  if (!falaSuportada() || !texto.trim()) {
    eventos.aoFim?.();
    return;
  }
  const minha = ++sessao;
  const sintese = window.speechSynthesis;
  let terminou = false;
  let comecou = false;
  const fim = () => {
    if (terminou || minha !== sessao) return;
    terminou = true;
    eventos.aoFim?.();
  };

  sintese.cancel();
  const voz = escolherVoz();
  filaAtual = dividir(texto).map((trecho, i, todos) => {
    const u = new SpeechSynthesisUtterance(trecho);
    if (voz) u.voice = voz;
    u.lang = voz?.lang ?? "pt-BR";
    u.rate = 1.04;
    u.pitch = 1;
    u.onstart = () => {
      comecou = true;
    };
    u.onboundary = () => eventos.aoPalavra?.();
    if (i === todos.length - 1) u.onend = fim;
    u.onerror = (e) => {
      // "interrupted"/"canceled" = outra fala tomou o lugar; o resto é falha real.
      if (e.error !== "interrupted" && e.error !== "canceled") fim();
    };
    return u;
  });

  // O Chrome às vezes engole a fala pedida logo após um cancel(): dá um respiro.
  window.setTimeout(() => {
    if (minha !== sessao) return;
    sintese.resume();
    for (const u of filaAtual) sintese.speak(u);
  }, 80);

  // Se a voz não começar (bloqueada, sem vozes instaladas), não deixa a esfera "falando" para sempre.
  window.setTimeout(() => {
    if (!comecou && !sintese.speaking) fim();
  }, 2500);
  // Teto de segurança: ~ 85 ms por letra + folga.
  window.setTimeout(fim, 4000 + texto.length * 85);
}

export function pararFala() {
  sessao++;
  filaAtual = [];
  if (falaSuportada()) window.speechSynthesis.cancel();
}
