import { useEffect, useRef } from "react";

import type { EstadoOrbe } from "./Orbe";

// Camadas de "plasma": cada uma é uma bolha deformada por senoides, somada com brilho.
const CAMADAS = [
  { cor: [124, 58, 237], fase: 0, velocidade: 0.9, escala: 1 },
  { cor: [34, 211, 238], fase: 2.1, velocidade: -1.15, escala: 0.86 },
  { cor: [244, 114, 182], fase: 4.2, velocidade: 1.35, escala: 0.74 },
  { cor: [167, 139, 250], fase: 1.3, velocidade: -0.7, escala: 0.62 },
] as const;

const ERRO = [251, 113, 133] as const;

const PARAMETROS: Record<EstadoOrbe, { amplitude: number; velocidade: number }> = {
  parado: { amplitude: 0.07, velocidade: 0.7 },
  ouvindo: { amplitude: 0.09, velocidade: 1.6 },
  pensando: { amplitude: 0.11, velocidade: 3.2 },
  falando: { amplitude: 0.1, velocidade: 2.1 },
  erro: { amplitude: 0.04, velocidade: 0.4 },
};

/**
 * Esfera animada do Argos. `nivel()` devolve 0–1: o volume do microfone quando
 * ouve, ou a "energia" da fala quando responde. Tudo desenhado em canvas a 60 fps.
 */
export function OrbePlasma({
  estado,
  nivel,
  tamanho = 132,
  movimento = true,
}: {
  estado: EstadoOrbe;
  nivel: () => number;
  tamanho?: number;
  movimento?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const estadoRef = useRef(estado);
  estadoRef.current = estado;
  const nivelRef = useRef(nivel);
  nivelRef.current = nivel;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = tamanho * dpr;
    canvas.height = tamanho * dpr;
    ctx.scale(dpr, dpr);

    let quadro = 0;
    let t = 0;
    let suave = 0;
    let amp = PARAMETROS.parado.amplitude;
    let vel = PARAMETROS.parado.velocidade;
    let ultimo = performance.now();

    const desenhar = (agora: number) => {
      const dt = Math.min(0.05, (agora - ultimo) / 1000);
      ultimo = agora;
      const e = estadoRef.current;
      const alvo = PARAMETROS[e];
      // Transições suaves entre estados.
      amp += (alvo.amplitude - amp) * 0.08;
      vel += (alvo.velocidade - vel) * 0.06;
      const bruto = e === "ouvindo" || e === "falando" ? nivelRef.current() : 0;
      suave += (bruto - suave) * (bruto > suave ? 0.35 : 0.12);
      t += dt * (movimento ? vel : 0.15);

      const c = tamanho / 2;
      // Respira devagar mesmo parada, e cresce com a voz.
      const respiro = movimento ? Math.sin(agora / 1100) * 0.025 : 0;
      const base = tamanho * 0.3 * (1 + respiro + suave * 0.24);
      ctx.clearRect(0, 0, tamanho, tamanho);

      // Halo externo.
      const halo = ctx.createRadialGradient(c, c, base * 0.6, c, c, tamanho * 0.5);
      const corHalo = e === "erro" ? ERRO : CAMADAS[0].cor;
      halo.addColorStop(0, `rgba(${corHalo.join(",")},${0.28 + suave * 0.3})`);
      halo.addColorStop(1, `rgba(${corHalo.join(",")},0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, tamanho, tamanho);

      ctx.globalCompositeOperation = "lighter";
      for (const [k, camada] of CAMADAS.entries()) {
        const cor = e === "erro" ? ERRO : camada.cor;
        const r = base * camada.escala;
        // Cada camada gira levemente fora do centro: as cores se separam num redemoinho.
        const desvio = base * (0.18 + suave * 0.14);
        const cx = c + Math.cos(t * 0.45 * camada.velocidade + camada.fase) * desvio * (k === 0 ? 0.3 : 1);
        const cy = c + Math.sin(t * 0.45 * camada.velocidade + camada.fase) * desvio * (k === 0 ? 0.3 : 1);
        const deformacao = movimento ? amp + suave * 0.45 : 0.02;
        ctx.beginPath();
        const pontos = 72;
        for (let i = 0; i <= pontos; i++) {
          const a = (i / pontos) * Math.PI * 2;
          const onda =
            Math.sin(a * 3 + t * camada.velocidade + camada.fase) * 0.55 +
            Math.sin(a * 5 - t * camada.velocidade * 1.3 + camada.fase * 2) * 0.3 +
            Math.sin(a * 2 + t * 0.6 + k) * 0.15;
          const rr = r * (1 + deformacao * onda);
          const x = cx + Math.cos(a + t * 0.15 * camada.velocidade) * rr;
          const y = cy + Math.sin(a + t * 0.15 * camada.velocidade) * rr;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.1, cx, cy, r * 1.1);
        g.addColorStop(0, `rgba(${cor.join(",")},0.5)`);
        g.addColorStop(0.65, `rgba(${cor.join(",")},0.26)`);
        g.addColorStop(1, `rgba(${cor.join(",")},0)`);
        ctx.fillStyle = g;
        ctx.fill();
      }

      // Núcleo claro.
      const nucleo = ctx.createRadialGradient(c, c, 0, c, c, base * 0.5);
      nucleo.addColorStop(0, `rgba(255,255,255,${0.2 + suave * 0.35})`);
      nucleo.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = nucleo;
      ctx.beginPath();
      ctx.arc(c, c, base * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";

      // Ouvindo/falando: um anel fino que se expande com o volume.
      if ((e === "ouvindo" || e === "falando") && movimento) {
        const ciclo = (agora / 1400) % 1;
        const raioAnel = base * (1.05 + ciclo * 0.55 + suave * 0.2);
        ctx.strokeStyle = `rgba(196,181,253,${(0.35 + suave * 0.4) * (1 - ciclo)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(c, c, raioAnel, 0, Math.PI * 2);
        ctx.stroke();
      }

      // "Pensando": partículas orbitando.
      if (e === "pensando") {
        for (let i = 0; i < 3; i++) {
          const a = t * 1.6 + (i * Math.PI * 2) / 3;
          const rr = base * 1.32;
          ctx.fillStyle = `rgba(255,255,255,${0.75 - i * 0.18})`;
          ctx.beginPath();
          ctx.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, 2.4 - i * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      quadro = requestAnimationFrame(desenhar);
    };
    quadro = requestAnimationFrame(desenhar);
    return () => cancelAnimationFrame(quadro);
  }, [tamanho, movimento]);

  return <canvas ref={ref} style={{ width: tamanho, height: tamanho, display: "block" }} aria-hidden="true" />;
}
