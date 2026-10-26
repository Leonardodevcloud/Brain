/**
 * Grava o microfone e mede o volume em tempo real (para a esfera reagir à voz
 * e para parar sozinho quando a pessoa fica em silêncio).
 */
export class Gravador {
  private stream: MediaStream | null = null;
  private gravador: MediaRecorder | null = null;
  private partes: Blob[] = [];
  private contexto: AudioContext | null = null;
  private analisador: AnalyserNode | null = null;
  private amostras: Uint8Array<ArrayBuffer> | null = null;
  private inicio = 0;
  /** Quando o volume passou do limiar pela última vez (fala detectada). */
  ultimaVoz = 0;
  /** Já houve fala desde o início? */
  falou = false;
  /** Ruído de fundo estimado: o limiar de "voz" se adapta ao ambiente. */
  private ruido = 0.03;

  static suportado() {
    return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  async iniciar() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => MediaRecorder.isTypeSupported(m));
    this.gravador = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48_000 } : undefined);
    this.partes = [];
    this.gravador.ondataavailable = (e) => {
      if (e.data.size) this.partes.push(e.data);
    };
    this.gravador.start(250);

    this.contexto = new AudioContext();
    const fonte = this.contexto.createMediaStreamSource(this.stream);
    this.analisador = this.contexto.createAnalyser();
    this.analisador.fftSize = 512;
    this.analisador.smoothingTimeConstant = 0.6;
    fonte.connect(this.analisador);
    this.amostras = new Uint8Array(new ArrayBuffer(this.analisador.fftSize));
    this.inicio = performance.now();
    this.ultimaVoz = this.inicio;
    this.falou = false;
    this.ruido = 0.03;
  }

  /** Volume de 0 a 1 (RMS com um ganho para a fala ficar visível). */
  nivel(): number {
    if (!this.analisador || !this.amostras) return 0;
    this.analisador.getByteTimeDomainData(this.amostras);
    let soma = 0;
    for (const v of this.amostras) {
      const x = (v - 128) / 128;
      soma += x * x;
    }
    const n = Math.min(1, Math.sqrt(soma / this.amostras.length) * 4.5);
    // O piso acompanha o ruído devagar (sobe pouco, desce rápido), para não confundir a fala com ruído.
    this.ruido = n < this.ruido ? this.ruido * 0.9 + n * 0.1 : this.ruido * 0.995 + n * 0.005;
    if (n > Math.max(0.12, this.ruido * 2.4)) {
      this.ultimaVoz = performance.now();
      this.falou = true;
    }
    return n;
  }

  duracao() {
    return this.inicio ? performance.now() - this.inicio : 0;
  }

  /** Para e devolve o áudio gravado. */
  parar(): Promise<Blob> {
    const g = this.gravador;
    if (!g || g.state === "inactive") {
      this.liberar();
      return Promise.resolve(new Blob());
    }
    return new Promise((resolve) => {
      g.onstop = () => {
        const blob = new Blob(this.partes, { type: g.mimeType || "audio/webm" });
        this.liberar();
        resolve(blob);
      };
      g.stop();
    });
  }

  cancelar() {
    if (this.gravador && this.gravador.state !== "inactive") {
      this.gravador.onstop = null;
      this.gravador.stop();
    }
    this.liberar();
  }

  private liberar() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.contexto?.close().catch(() => undefined);
    this.stream = null;
    this.gravador = null;
    this.contexto = null;
    this.analisador = null;
    this.amostras = null;
    this.inicio = 0;
  }
}
