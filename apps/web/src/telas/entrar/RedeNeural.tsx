import { useEffect, useRef } from "react";

/**
 * Fundo da tela de entrada: uma rede neural viva.
 * Nós flutuando, ligações entre os próximos, pulsos de dados correndo pelas ligações
 * e o cursor "puxando" conexões. Com movimento reduzido, desenha um quadro parado.
 */

interface No {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  brilho: number;
}
interface Pulso {
  a: number;
  b: number;
  t: number;
  vel: number;
}

const ALCANCE = 135;
const ALCANCE_CURSOR = 180;

export function RedeNeural({ className }: { className?: string }) {
  const tela = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = tela.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const parado = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let largura = 0;
    let altura = 0;
    let nos: No[] = [];
    let pulsos: Pulso[] = [];
    let quadro = 0;
    let ultimoPulso = 0;
    const cursor = { x: -9999, y: -9999, ativo: false };

    function montar() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      largura = canvas!.clientWidth;
      altura = canvas!.clientHeight;
      canvas!.width = Math.round(largura * dpr);
      canvas!.height = Math.round(altura * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      const total = Math.max(28, Math.min(120, Math.round((largura * altura) / 13000)));
      nos = Array.from({ length: total }, () => ({
        x: Math.random() * largura,
        y: Math.random() * altura,
        vx: (Math.random() - 0.5) * 0.28,
        vy: (Math.random() - 0.5) * 0.28,
        r: 0.9 + Math.random() * 1.6,
        brilho: 0,
      }));
      pulsos = [];
    }

    function vizinhos(i: number) {
      const a = nos[i]!;
      const lista: number[] = [];
      for (let j = 0; j < nos.length; j++) {
        if (j === i) continue;
        const b = nos[j]!;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < ALCANCE * ALCANCE) lista.push(j);
      }
      return lista;
    }

    function novoPulso(origem?: number) {
      const a = origem ?? Math.floor(Math.random() * nos.length);
      const v = vizinhos(a);
      if (!v.length) return;
      const b = v[Math.floor(Math.random() * v.length)]!;
      pulsos.push({ a, b, t: 0, vel: 0.012 + Math.random() * 0.014 });
    }

    function desenhar(agora: number) {
      ctx!.clearRect(0, 0, largura, altura);

      // Movimento.
      if (!parado) {
        for (const n of nos) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < -20) n.x = largura + 20;
          if (n.x > largura + 20) n.x = -20;
          if (n.y < -20) n.y = altura + 20;
          if (n.y > altura + 20) n.y = -20;
          n.brilho *= 0.95;
        }
      }

      // Ligações.
      ctx!.lineWidth = 1;
      for (let i = 0; i < nos.length; i++) {
        const a = nos[i]!;
        for (let j = i + 1; j < nos.length; j++) {
          const b = nos[j]!;
          const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
          if (d2 > ALCANCE * ALCANCE) continue;
          const forca = 1 - Math.sqrt(d2) / ALCANCE;
          ctx!.strokeStyle = `rgba(139, 92, 246, ${(0.05 + forca * 0.22).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      // Cursor puxando conexões.
      if (cursor.ativo) {
        for (const n of nos) {
          const d = Math.hypot(n.x - cursor.x, n.y - cursor.y);
          if (d > ALCANCE_CURSOR) continue;
          const forca = 1 - d / ALCANCE_CURSOR;
          n.brilho = Math.max(n.brilho, forca);
          ctx!.strokeStyle = `rgba(196, 181, 253, ${(forca * 0.45).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.moveTo(n.x, n.y);
          ctx!.lineTo(cursor.x, cursor.y);
          ctx!.stroke();
        }
      }

      // Pulsos de dados.
      if (!parado && agora - ultimoPulso > 220 && pulsos.length < 26) {
        novoPulso();
        ultimoPulso = agora;
      }
      pulsos = pulsos.filter((p) => {
        const a = nos[p.a];
        const b = nos[p.b];
        if (!a || !b) return false;
        p.t += p.vel;
        if (p.t >= 1) {
          b.brilho = 1;
          if (Math.random() < 0.55) novoPulso(p.b); // o sinal segue pela rede
          return false;
        }
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t;
        const g = ctx!.createRadialGradient(x, y, 0, x, y, 7);
        g.addColorStop(0, "rgba(237, 233, 254, 0.95)");
        g.addColorStop(0.4, "rgba(167, 139, 250, 0.5)");
        g.addColorStop(1, "rgba(124, 58, 237, 0)");
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(x, y, 7, 0, Math.PI * 2);
        ctx!.fill();
        return true;
      });

      // Nós.
      for (const n of nos) {
        if (n.brilho > 0.05) {
          const g = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, 10 + n.brilho * 8);
          g.addColorStop(0, `rgba(167, 139, 250, ${(n.brilho * 0.55).toFixed(3)})`);
          g.addColorStop(1, "rgba(124, 58, 237, 0)");
          ctx!.fillStyle = g;
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, 10 + n.brilho * 8, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.fillStyle = n.brilho > 0.3 ? "#EDE9FE" : "rgba(196, 181, 253, 0.75)";
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.r + n.brilho * 1.2, 0, Math.PI * 2);
        ctx!.fill();
      }

      if (!parado) quadro = requestAnimationFrame(desenhar);
    }

    function mover(e: PointerEvent) {
      const caixa = canvas!.getBoundingClientRect();
      cursor.x = e.clientX - caixa.left;
      cursor.y = e.clientY - caixa.top;
      cursor.ativo = true;
      if (parado) desenhar(performance.now());
    }
    function sair() {
      cursor.ativo = false;
    }

    montar();
    if (parado) desenhar(0);
    else quadro = requestAnimationFrame(desenhar);

    const observador = new ResizeObserver(() => {
      montar();
      if (parado) desenhar(0);
    });
    observador.observe(canvas);
    window.addEventListener("pointermove", mover, { passive: true });
    document.addEventListener("pointerleave", sair);
    return () => {
      cancelAnimationFrame(quadro);
      observador.disconnect();
      window.removeEventListener("pointermove", mover);
      document.removeEventListener("pointerleave", sair);
    };
  }, []);

  return <canvas ref={tela} className={className} aria-hidden="true" />;
}
