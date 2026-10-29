/**
 * Voz do Argos.
 * 1º: voz natural gerada no servidor (OpenAI) — a mesma em qualquer aparelho.
 * 2º (sem a chave, ou se falhar): a síntese de fala do próprio navegador.
 */
import { dividirFala } from "@cerebro/core/publico";
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

const dividir = dividirFala;

/**
 * Onde existe MediaSource para MP3 (Chrome, Edge, Firefox, Android), o áudio toca enquanto chega:
 * o 1º pedaço já sai em ~50 ms. No iPhone/Safari, o trecho é baixado inteiro (o servidor já o adiantou).
 */
const tocaEmFluxo = () => {
  try {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
};

/** 1º trecho já em geração no servidor (veio junto com a resposta do Argos). */
export type VozPreparada = { id: string; texto: string } | null | undefined;

export function falar(texto: string, eventos: Eventos = {}, preparada?: VozPreparada) {
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
    falarServidor(texto, eventos, minha, preparada).catch((erro: { comecou?: boolean }) => {
      if (minha !== sessao) return;
      console.warn("[Argos] voz do servidor falhou", erro);
      // Só troca para a voz do navegador se nada tiver tocado ainda: nunca duas vozes na mesma resposta.
      if (!erro?.comecou) falarNavegador(texto, eventos, minha);
      else eventos.aoFim?.();
    });
  });
}

const esperar = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** Pede para o servidor começar a gerar um trecho; devolve o id do áudio. */
async function preparar(texto: string, sinal: AbortSignal): Promise<string> {
  try {
    return (await api<{ id: string }>("/argos/falar/preparar", { metodo: "POST", corpo: { texto }, sinal })).id;
  } catch (erro) {
    if (sinal.aborted) throw erro;
    await new Promise((r) => setTimeout(r, 300));
    return (await api<{ id: string }>("/argos/falar/preparar", { metodo: "POST", corpo: { texto }, sinal })).id;
  }
}

/** O áudio inteiro de um trecho já preparado (para o Safari, ou se o fluxo falhar). */
async function baixar(id: string, sinal: AbortSignal): Promise<string> {
  const r = await fetch(`/api/argos/falar/${id}`, { signal: sinal, credentials: "same-origin" });
  if (!r.ok) throw new Error(`voz ${r.status}`);
  const url = URL.createObjectURL(await r.blob());
  urls.push(url);
  return url;
}

async function falarServidor(texto: string, eventos: Eventos, minha: number, preparada?: VozPreparada) {
  cancelarPedidos = new AbortController();
  const sinal = cancelarPedidos.signal;
  const partes = dividir(texto);
  // Todos os trechos começam a ser gerados já (o 1º normalmente já veio adiantado com a resposta).
  const ids = partes.map((p, i) => (i === 0 && preparada?.texto === p ? Promise.resolve(preparada.id) : preparar(p, sinal)));
  for (const p of ids) p.catch(() => undefined); // evita "unhandled rejection" dos que ainda não chegaram a vez
  const emFluxo = tocaEmFluxo();
  // No modo de download, o próximo trecho já vai baixando enquanto o atual toca.
  const arquivos = emFluxo ? [] : ids.map((p) => p.then((id) => baixar(id, sinal)));
  for (const p of arquivos) p.catch(() => undefined);

  tocador ??= new Audio();
  const t = tocador;
  let pulso: number | undefined;
  let comecou = false;

  const comecar = () => {
    comecou = true;
    medirTocador(t);
    // A esfera acompanha a fala (o áudio não expõe as palavras; um ritmo de fala serve).
    window.clearInterval(pulso);
    pulso = window.setInterval(() => eventos.aoPalavra?.(), 190);
  };

  const tocar = (src: string) =>
    new Promise<void>((ok, falha) => {
      t.onended = () => ok();
      t.onerror = () => falha(new Error("áudio inválido"));
      t.src = src;
      t.play().then(comecar, falha);
    });

  /** Toca o trecho enquanto ele chega do servidor (MediaSource). */
  const tocarEmFluxo = async (id: string) => {
    const resposta = await fetch(`/api/argos/falar/${id}`, { signal: sinal, credentials: "same-origin" });
    if (!resposta.ok || !resposta.body) throw new Error(`voz ${resposta.status}`);
    const fonte = new MediaSource();
    const url = URL.createObjectURL(fonte);
    urls.push(url);
    const terminou = new Promise<void>((ok, falha) => {
      t.onended = () => ok();
      t.onerror = () => falha(new Error("áudio inválido"));
    });
    terminou.catch(() => undefined);
    t.preload = "auto";
    t.src = url;
    const abriu = new Promise((ok) => fonte.addEventListener("sourceopen", ok, { once: true }));
    await Promise.race([abriu, esperar(3000)]);
    if (fonte.readyState !== "open") throw new Error("o fluxo não abriu");
    const buffer = fonte.addSourceBuffer("audio/mpeg");
    const anexar = (pedaco: Uint8Array) =>
      new Promise<void>((ok, falha) => {
        buffer.addEventListener("updateend", () => ok(), { once: true });
        buffer.addEventListener("error", () => falha(new Error("áudio inválido")), { once: true });
        buffer.appendBuffer(pedaco as Uint8Array<ArrayBuffer>);
      });
    const leitor = resposta.body.getReader();
    // O play() só termina quando há áudio suficiente: por isso NÃO esperamos por ele aqui —
    // a leitura continua entregando pedaços enquanto o navegador junta o bastante para começar.
    let tocando: Promise<void> | null = null;
    let desistiu = false;
    // Sem som em 6 s: desiste do fluxo (o trecho é baixado inteiro em seguida).
    const vigia = window.setTimeout(() => {
      if (comecou) return;
      desistiu = true;
      leitor.cancel().catch(() => undefined);
    }, 6000);
    try {
      for (;;) {
        const { done, value } = await leitor.read();
        if (minha !== sessao) return;
        if (done) break;
        if (!value?.byteLength) continue;
        await anexar(value);
        tocando ??= t.play().then(comecar);
        tocando.catch(() => undefined);
      }
    } finally {
      window.clearTimeout(vigia);
    }
    if (fonte.readyState === "open") fonte.endOfStream();
    if (desistiu) throw new Error("o fluxo não começou a tocar");
    if (!tocando) return; // veio vazio: nada a tocar
    await Promise.race([tocando, esperar(4000)]);
    if (!comecou) throw new Error("o fluxo não começou a tocar");
    // Se o "ended" não vier (alguns navegadores com MediaSource), sai quando o áudio parar no fim.
    await Promise.race([
      terminou,
      new Promise<void>((ok) => {
        let parado = 0;
        const id = window.setInterval(() => {
          if (minha !== sessao) return (window.clearInterval(id), ok());
          const fim = t.buffered.length ? t.buffered.end(t.buffered.length - 1) : 0;
          parado = t.currentTime >= fim - 0.15 ? parado + 1 : 0;
          if (parado >= 6) {
            window.clearInterval(id);
            ok();
          }
        }, 250);
        void terminou.finally(() => window.clearInterval(id));
      }),
    ]);
  };

  try {
    for (let i = 0; i < partes.length; i++) {
      if (emFluxo) {
        const id = await ids[i]!;
        if (minha !== sessao) return;
        try {
          await tocarEmFluxo(id);
        } catch (erro) {
          if (minha !== sessao || sinal.aborted) return;
          if (comecou) throw erro;
          // O fluxo não tocou neste navegador: baixa o arquivo do mesmo trecho e tenta de novo.
          console.warn("[Argos] fluxo de voz falhou; baixando o trecho", erro);
          await tocar(await baixar(id, sinal));
        }
      } else {
        const url = await arquivos[i]!;
        if (minha !== sessao) return;
        await tocar(url);
      }
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
