import { useEffect, useRef, useState } from "react";
import { carregarThree, criarNebulosa, webglDisponivel } from "../../componentes/particulas/nebulosa";
import { RedeNeural } from "./RedeNeural";

/**
 * Fundo da tela de entrada: a Nebulosa do Argos em tamanho grande, com poeira de estrelas,
 * respirando devagar e seguindo o mouse. Sem WebGL, volta para a constelação em 2D.
 */
export function NebulosaEntrada({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [plano, setPlano] = useState(() => !webglDisponivel());

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || plano) return;
    const movimento = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let desmontar: (() => void) | null = null;
    let vivo = true;
    const inicio = performance.now();
    carregarThree()
      .then((THREE) => {
        if (!vivo) return;
        desmontar = criarNebulosa(
          THREE,
          canvas,
          { particulas: 9000, poeira: 1400, seguirMouse: true, centro: { x: 0.08, y: 0.24 }, escala: 0.78, movimento },
          () => {
            // Respira devagar, com um pulso mais forte de vez em quando (como se falasse baixinho).
            const t = (performance.now() - inicio) / 1000;
            const respira = 0.1 + 0.08 * Math.sin(t * 0.9);
            const pulso = Math.max(0, Math.sin(t * 0.37)) ** 12 * 0.35;
            return { nivel: respira + pulso, pensar: 0, ouvir: 0, erro: 0 };
          },
        );
      })
      .catch(() => {
        if (vivo) setPlano(true);
      });
    return () => {
      vivo = false;
      desmontar?.();
    };
  }, [plano]);

  if (plano) return <RedeNeural className={className} />;
  return <canvas ref={ref} className={className} />;
}
