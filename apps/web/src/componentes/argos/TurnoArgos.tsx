import { ArrowRight, ChevronDown } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";
import type { TurnoConversa } from "./conversa";
import { DadosCentral } from "./DadosCentral";
import { MemoriaDaResposta } from "./Memoria";
import css from "./Argos.module.css";

const Conteudo = lazy(() => import("../Conteudo").then((m) => ({ default: m.Conteudo })));

/** Uma troca da conversa: o que a pessoa disse e a resposta do Argos (com dados, fontes e ação). */
export function TurnoArgos({ t, irPara, fechar }: { t: TurnoConversa; irPara: (destino: string) => void; fechar: () => void }) {
  const [completo, setCompleto] = useState(false);
  const r = t.resposta;
  return (
    <article className={css.turno}>
      <p className={css.bolhaVoce}>{t.pergunta}</p>
      {!r && !t.erro && (
        <p className={css.statusFio}>
          Pensando e consultando os dados<span className={css.reticencias} aria-hidden="true" />
        </p>
      )}
      {t.erro && <p className={css.erro}>{t.erro}</p>}
      {r && (
        <div className={css.bolhaArgos}>
          <p className={css.falaTurno}>{r.fala}</p>
          {r.dados && <DadosCentral dados={r.dados} compacto />}
          <MemoriaDaResposta t={t} aoAbrir={fechar} />
          {r.fontes.length > 0 && (
            <div className={css.fontesTurno}>
              {r.fontes.slice(0, 4).map((f) => (
                <Link key={f.registroId} to={`/registros/${f.codigo}`} className={css.fonte} onClick={fechar}>
                  <span className={css.fonteCodigo}>{f.codigo}</span> {f.titulo}
                </Link>
              ))}
            </div>
          )}
          {r.detalhe && (
            <>
              <button type="button" className={css.verMais} onClick={() => setCompleto((v) => !v)} aria-expanded={completo}>
                {completo ? "Esconder resposta completa" : "Ver resposta completa"}
                <ChevronDown size={14} aria-hidden="true" style={{ transform: completo ? "rotate(180deg)" : undefined }} />
              </button>
              {completo && (
                <div className={css.completo}>
                  <Suspense fallback={null}>
                    <Conteudo
                      texto={r.detalhe.replace(/\[(\d+)\]/g, (marca, n: string) => {
                        const f = r.fontes.find((x) => x.indice === Number(n));
                        return f ? `[[${n}]](/registros/${f.codigo})` : marca;
                      })}
                    />
                  </Suspense>
                </div>
              )}
            </>
          )}
          {r.acao && !r.acao.automatica && (
            <button type="button" className={`botao botao-primario botao-pequeno ${css.acaoTurno}`} onClick={() => irPara(r.acao!.destino)}>
              {r.acao.rotulo} <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}
