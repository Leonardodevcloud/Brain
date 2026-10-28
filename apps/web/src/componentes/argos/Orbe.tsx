import { useEffect, useRef, useState } from "react";
import { carregarThree, criarNebulosa, webglDisponivel } from "../particulas/nebulosa";
import { OrbePlasma } from "./OrbePlasma";

export type EstadoOrbe = "parado" | "ouvindo" | "pensando" | "falando" | "erro";

interface PropsOrbe {
  estado: EstadoOrbe;
  /** 0–1: o volume do microfone quando ouve, ou o da fala quando responde. */
  nivel: () => number;
  tamanho?: number;
  movimento?: boolean;
}

const celular = () => typeof window !== "undefined" && (window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 760);

/** Menos partículas em esferas pequenas e no celular; pontos maiores para continuarem visíveis. */
function medidas(tamanho: number) {
  const fator = celular() ? 0.6 : 1;
  if (tamanho >= 120) return { particulas: Math.round(6500 * fator), ponto: 1.5 };
  if (tamanho >= 48) return { particulas: Math.round(1600 * fator), ponto: 2.1 };
  return { particulas: Math.round(1100 * fator), ponto: 2.6 };
}

/**
 * Esfera do Argos: a Nebulosa (partículas em 3D). Sem WebGL, ou se o Three.js não carregar,
 * volta para a esfera desenhada em 2D.
 */
export function Orbe(props: PropsOrbe) {
  const [modo, setModo] = useState<"nebulosa" | "plasma">(() => (webglDisponivel() ? "nebulosa" : "plasma"));
  if (modo === "plasma") return <OrbePlasma {...props} />;
  return <OrbeNebulosa {...props} aoFalhar={() => setModo("plasma")} />;
}

function OrbeNebulosa({ estado, nivel, tamanho = 132, movimento = true, aoFalhar }: PropsOrbe & { aoFalhar: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const estadoRef = useRef(estado);
  estadoRef.current = estado;
  const nivelRef = useRef(nivel);
  nivelRef.current = nivel;
  const falhouRef = useRef(aoFalhar);
  falhouRef.current = aoFalhar;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let desmontar: (() => void) | null = null;
    let vivo = true;
    carregarThree()
      .then((THREE) => {
        if (!vivo) return;
        const { particulas, ponto } = medidas(tamanho);
        desmontar = criarNebulosa(THREE, canvas, { particulas, ponto, movimento }, () => {
          const e = estadoRef.current;
          const v = e === "ouvindo" || e === "falando" ? Math.min(1, Math.max(0, nivelRef.current())) : 0;
          return { nivel: v, pensar: e === "pensando" ? 1 : 0, ouvir: e === "ouvindo" ? 1 : 0, erro: e === "erro" ? 1 : 0 };
        });
      })
      .catch(() => {
        if (vivo) falhouRef.current();
      });
    return () => {
      vivo = false;
      desmontar?.();
    };
  }, [tamanho, movimento]);

  return <canvas ref={ref} width={tamanho} height={tamanho} style={{ width: tamanho, height: tamanho, display: "block" }} aria-hidden="true" />;
}
