/**
 * Voz do Argos.
 * 1º: voz natural gerada no servidor (OpenAI) — a mesma em qualquer aparelho.
 * 2º (sem a chave, ou se falhar): a síntese de fala do próprio navegador.
 */
import { api } from "../../api/cliente";

interface ConfigVoz {
  disponivel: boolean;
  voz: string;
  velocidade: number;
}

type Eventos = { aoPalavra?: () => void; aoFim?: () => void };

let config: Promise<ConfigVoz | null> | null = null;
let sessao = 0;
// Um único elemento de áudio, liberado num gesto da pessoa (o Safari do iPhone exige isso).
let tocador: HTMLAudioElement | null = null;
let urls: string[] = [];
let cancelarPedidos: AbortController | null = null;

// Volume real da voz do Argos (para a esfera "falar" junto). Só onde o navegador deixa
// ler o áudio que está tocando (Chrome/Edge); nos outros a esfera usa um ritmo de fala.
let ouvinte: { contexto: AudioContext; analisador: AnalyserNode; amostras: Uint8Array<ArrayBuffer> } | null = null;

function medirTocador(t: HTMLAudioElement) {
  soltarOuvinte();
  const capturar = (t as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capturar !== "function") return;
  try {
    const stream = capturar.call(t);
    if (!stream.getAudioTracks().length) return;
    let contexto: AudioContext;
    try {
      contexto = new AudioContext({ sinkId: { type: "none" } } as AudioContextOptions);
    } catch {
      contexto = new AudioContext();
    }
    const analisador = contexto.createAnalyser();
    analisador.fftSize = 512;
    analisador.smoothingTimeConstant = 0.55;
    contexto.createMediaStreamSource(stream).connect(analisador);
    ouvinte = { contexto, analisador, amostras: new Uint8Array(new ArrayBuffer(analisador.fftSize)) };
  } catch {
    ouvinte = null;
  }
}

function soltarOuvinte() {
  if (!ouvinte) return;
  void ouvinte.contexto.close().catch(() => undefined);
  ouvinte = null;
}

/** 0–1 enquanto a voz do servidor toca; `null` quando não dá para medir. */
export function nivelFala(): number | null {
  if (!ouvinte) return null;
  ouvinte.analisador.getByteTimeDomainData(ouvinte.amostras);
  let soma = 0;
  for (const v of ouvinte.amostras) {
    const x = (v - 128) / 128;
    soma += x * x;
  }
  return Math.min(1, Math.sqrt(soma / ouvinte.amostras.length) * 5);
}

/** Lê (uma vez) qual voz a empresa escolheu. */
export function lerConfigVoz(): Promise<ConfigVoz | null> {
  config ??= api<ConfigVoz>("/argos/voz").catch(() => null);
  return config;
}

/** Depois de trocar a voz em Integrações. */
export function recarregarVoz() {
  config = null;
  void lerConfigVoz();
}

export const falaSuportada = () => typeof window !== "undefined" && ("speechSynthesis" in window || typeof Audio !== "undefined");

/** 100 ms de silêncio em WAV, para liberar o áudio dentro do gesto. */
function silencio(): string {
  const amostras = 800;
  const b = new ArrayBuffer(44 + amostras * 2);
  const v = new DataView(b);
  const txt = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, "RIFF");
  v.setUint32(4, 36 + amostras * 2, true);
  txt(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  txt(36, "data");
  v.setUint32(40, amostras * 2, true);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

/**
 * Chamar dentro de um gesto (tecla ou clique): libera o áudio no Chrome/Safari,
 * que bloqueiam som que começa longe de uma ação da pessoa.
 */
export function desbloquearFala() {
  void lerConfigVoz();
  try {
    if (typeof Audio !== "undefined") {
      tocador ??= new Audio();
      tocador.src = silencio();
      void tocador.play().catch(() => undefined);
    }
    if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* sem áudio: o Argos segue só com texto */
  }
}

/** Frases curtas: a primeira sai rápido e o resto vem enquanto ela toca. */
function dividir(texto: string, primeiro = 110, demais = 260): string[] {
  const frases = texto.replace(/\s+/g, " ").match(/[^.!?;]+[.!?;]*/g) ?? [texto];
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

export function falar(texto: string, eventos: Eventos = {}) {
  pararFala();
  const minha = sessao;
  if (!texto.trim()) {
    eventos.aoFim?.();
    return;
  }
  void lerConfigVoz().then((cfg) => {
    if (minha !== sessao) return;
    if (!cfg?.disponivel) {
      falarNavegador(texto, eventos, minha);
      return;
    }
    falarServidor(texto, eventos, minha).catch((erro: { comecou?: boolean }) => {
      if (minha !== sessao) return;
      console.warn("[Argos] voz do servidor falhou", erro);
      // Só troca para a voz do navegador se nada tiver tocado ainda: nunca duas vozes na mesma resposta.
      if (!erro?.comecou) falarNavegador(texto, eventos, minha);
      else eventos.aoFim?.();
    });
  });
}

/** Pede um trecho; se falhar (rede, limite da API), tenta mais uma vez. */
async function pedirTrecho(texto: string, sinal: AbortSignal): Promise<Blob> {
  try {
    return await api<Blob>("/argos/falar", { metodo: "POST", corpo: { texto }, sinal, bruto: true });
  } catch (erro) {
    if (sinal.aborted) throw erro;
    await new Promise((r) => setTimeout(r, 400));
    return api<Blob>("/argos/falar", { metodo: "POST", corpo: { texto }, sinal, bruto: true });
  }
}

async function falarServidor(texto: string, eventos: Eventos, minha: number) {
  cancelarPedidos = new AbortController();
  const sinal = cancelarPedidos.signal;
  const partes = dividir(texto);
  // O primeiro trecho é pedido na hora; os outros logo em seguida, para já estarem prontos quando chegar a vez.
  const trechos: Promise<Blob>[] = [];
  trechos[0] = pedirTrecho(partes[0]!, sinal);
  for (let i = 1; i < partes.length; i++) trechos[i] = pedirTrecho(partes[i]!, sinal);
  for (const p of trechos) p.catch(() => undefined); // evita "unhandled rejection" dos que ainda não chegaram a vez

  tocador ??= new Audio();
  const t = tocador;
  let pulso: number | undefined;
  let comecou = false;
  try {
    for (let i = 0; i < trechos.length; i++) {
      const audio = await trechos[i]!;
      if (minha !== sessao) return;
      const url = URL.createObjectURL(audio);
      urls.push(url);
      await new Promise<void>((ok, falha) => {
        t.onended = () => ok();
        t.onerror = () => falha(new Error("áudio inválido"));
        t.src = url;
        t.play().then(() => {
          comecou = true;
          medirTocador(t);
          // A esfera acompanha a fala (o áudio não expõe as palavras; um ritmo de fala serve).
          window.clearInterval(pulso);
          pulso = window.setInterval(() => eventos.aoPalavra?.(), 190);
        }, falha);
      });
    }
  } catch (erro) {
    throw Object.assign(erro instanceof Error ? erro : new Error(String(erro)), { comecou });
  } finally {
    window.clearInterval(pulso);
    soltarOuvinte();
    t.onended = null;
    t.onerror = null;
  }
  if (minha === sessao) eventos.aoFim?.();
}

let vozNavegador: SpeechSynthesisVoice | null | undefined;
function escolherVozNavegador(): SpeechSynthesisVoice | null {
  if (vozNavegador !== undefined) return vozNavegador;
  const vozes = window.speechSynthesis?.getVoices() ?? [];
  if (!vozes.length) return null;
  const pt = vozes.filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith("pt"));
  const nota = (v: SpeechSynthesisVoice) =>
    (v.lang.toLowerCase().replace("_", "-") === "pt-br" ? 4 : 0) +
    (/natural|neural|online/i.test(v.name) ? 3 : 0) +
    (v.localService ? 2 : 0) +
    (/francisca|thalita|maria/i.test(v.name) ? 1 : 0);
  vozNavegador = pt.sort((a, b) => nota(b) - nota(a))[0] ?? null;
  return vozNavegador;
}
if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged = () => {
    vozNavegador = undefined;
  };
}

function falarNavegador(texto: string, eventos: Eventos, minha: number) {
  if (!("speechSynthesis" in window)) {
    eventos.aoFim?.();
    return;
  }
  const sintese = window.speechSynthesis;
  let terminou = false;
  let comecou = false;
  const fim = () => {
    if (terminou || minha !== sessao) return;
    terminou = true;
    eventos.aoFim?.();
  };
  const voz = escolherVozNavegador();
  const fila = dividir(texto, 180, 180).map((trecho, i, todos) => {
    const u = new SpeechSynthesisUtterance(trecho);
    if (voz) u.voice = voz;
    u.lang = voz?.lang ?? "pt-BR";
    u.rate = 1.12;
    u.onstart = () => {
      comecou = true;
    };
    u.onboundary = () => eventos.aoPalavra?.();
    if (i === todos.length - 1) u.onend = fim;
    u.onerror = (e) => {
      if (e.error !== "interrupted" && e.error !== "canceled") fim();
    };
    return u;
  });
  // Guardadas aqui: o Chrome descarta falas sem referência e o "fim" nunca chega.
  (falarNavegador as { fila?: SpeechSynthesisUtterance[] }).fila = fila;
  window.setTimeout(() => {
    if (minha !== sessao) return;
    sintese.resume();
    for (const u of fila) sintese.speak(u);
  }, 80);
  window.setTimeout(() => {
    if (!comecou && !sintese.speaking) fim();
  }, 2500);
  window.setTimeout(fim, 4000 + texto.length * 80);
}

export function pararFala() {
  sessao++;
  soltarOuvinte();
  cancelarPedidos?.abort();
  cancelarPedidos = null;
  if (tocador) {
    tocador.onended = null;
    tocador.pause();
  }
  for (const u of urls) URL.revokeObjectURL(u);
  urls = [];
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

/** Para Integrações: ouvir uma voz antes de escolher. */
export async function ouvirAmostra(voz: string, velocidade: number, nome: string) {
  pararFala();
  const audio = await api<Blob>("/argos/falar", {
    metodo: "POST",
    corpo: { texto: `Oi, ${nome}! Eu sou o Argos. Agora são vinte e quatro motoboys em loja, e a loja mais crítica é a do Farol.`, voz, velocidade },
    bruto: true,
  });
  tocador ??= new Audio();
  const url = URL.createObjectURL(audio);
  urls.push(url);
  tocador.src = url;
  await tocador.play();
}
