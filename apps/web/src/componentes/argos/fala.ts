/** Voz do Argos com a síntese de fala do próprio navegador (gratuita). */

let vozEscolhida: SpeechSynthesisVoice | null | undefined;

function escolherVoz(): SpeechSynthesisVoice | null {
  if (vozEscolhida !== undefined) return vozEscolhida;
  const vozes = window.speechSynthesis?.getVoices() ?? [];
  if (!vozes.length) return null; // ainda carregando: tenta de novo na próxima fala
  const pt = vozes.filter((v) => v.lang.toLowerCase().startsWith("pt"));
  const nota = (v: SpeechSynthesisVoice) =>
    (v.lang.toLowerCase() === "pt-br" ? 4 : 0) +
    (/natural|neural|online/i.test(v.name) ? 3 : 0) +
    (/google/i.test(v.name) ? 2 : 0) +
    (/francisca|thalita|luciana|antonio/i.test(v.name) ? 1 : 0);
  vozEscolhida = pt.sort((a, b) => nota(b) - nota(a))[0] ?? null;
  return vozEscolhida;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {
    vozEscolhida = undefined;
  };
}

export const falaSuportada = () => typeof window !== "undefined" && "speechSynthesis" in window;

export function falar(texto: string, eventos: { aoPalavra?: () => void; aoFim?: () => void } = {}) {
  if (!falaSuportada() || !texto.trim()) {
    eventos.aoFim?.();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto);
  const voz = escolherVoz();
  if (voz) u.voice = voz;
  u.lang = voz?.lang ?? "pt-BR";
  u.rate = 1.04;
  u.pitch = 1;
  u.onboundary = () => eventos.aoPalavra?.();
  u.onend = () => eventos.aoFim?.();
  u.onerror = () => eventos.aoFim?.();
  window.speechSynthesis.speak(u);
}

export function pararFala() {
  if (falaSuportada()) window.speechSynthesis.cancel();
}
