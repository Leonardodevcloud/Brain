import { useEffect, useRef, useState } from "react";
import { carregarThree } from "../../componentes/particulas/nebulosa";
import { Cena3D } from "./cena3d";
import type { Ligacao, No } from "./desenho";
import css from "./Mapa.module.css";

/**
 * O mapa em partículas (3D). Recebe os mesmos nós, ligações e destaques do mapa plano
 * e avisa quando a pessoa aponta ou clica num registro.
 */
export function Mapa3D({
  nos,
  ligacoes,
  destaque,
  principal,
  movimento,
  deslocamento,
  aoApontar,
  aoClicar,
  aoPronto,
  aoFalhar,
}: {
  nos: No[];
  ligacoes: Ligacao[];
  destaque: Set<string>;
  principal: string | null;
  movimento: boolean;
  deslocamento: { x: number; y: number };
  aoApontar: (id: string | null) => void;
  aoClicar: (id: string | null) => void;
  aoPronto: (cena: Cena3D | null) => void;
  aoFalhar: () => void;
}) {
  const tela = useRef<HTMLCanvasElement>(null);
  const camada = useRef<HTMLDivElement>(null);
  const [cena, setCena] = useState<Cena3D | null>(null);
  const eventos = useRef({ apontou: aoApontar, clicou: aoClicar });
  eventos.current = { apontou: aoApontar, clicou: aoClicar };
  const prontoRef = useRef(aoPronto);
  prontoRef.current = aoPronto;
  const falhouRef = useRef(aoFalhar);
  falhouRef.current = aoFalhar;

  useEffect(() => {
    const canvas = tela.current;
    const rotulos = camada.current;
    if (!canvas || !rotulos) return;
    let vivo = true;
    let criada: Cena3D | null = null;
    carregarThree()
      .then((THREE) => {
        if (!vivo) return;
        const leve = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 860;
        criada = new Cena3D(
          THREE,
          canvas,
          rotulos,
          { apontou: (id) => eventos.current.apontou(id), clicou: (id) => eventos.current.clicou(id) },
          movimento,
          leve,
        );
        setCena(criada);
      })
      .catch(() => {
        if (vivo) falhouRef.current();
      });
    return () => {
      vivo = false;
      criada?.destruir();
      setCena(null);
      prontoRef.current(null);
    };
  }, [movimento]);

  // Dados novos (ou filtros): monta de novo e enquadra na primeira vez.
  const primeira = useRef(true);
  useEffect(() => {
    if (!cena) return;
    cena.definirDados(nos, ligacoes);
    if (primeira.current) {
      primeira.current = false;
      cena.enquadrar();
    }
    prontoRef.current(cena);
  }, [cena, nos, ligacoes]);

  useEffect(() => {
    cena?.destacar(destaque, principal);
  }, [cena, destaque, principal, nos, ligacoes]);

  useEffect(() => {
    cena?.deslocar(deslocamento.x, deslocamento.y);
  }, [cena, deslocamento.x, deslocamento.y]);

  return (
    <>
      <canvas ref={tela} className={css.tela3d} />
      <div ref={camada} className={css.rotulos3d} aria-hidden="true" />
    </>
  );
}
