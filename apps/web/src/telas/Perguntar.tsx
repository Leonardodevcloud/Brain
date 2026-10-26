import type { FonteDTO, RespostaPerguntaDTO } from "@cerebro/core/publico";
import { Copy, Search } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usePerguntar } from "../api/consultas";
import { Esqueleto, MensagemErro, useAvisar } from "../componentes/comum";
import { Conteudo } from "../componentes/Conteudo";
import { NOME_STATUS, nomeTipo, prazoRevisao } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Perguntar.module.css";

/** Troca as citações [1] por links para o registro correspondente. */
function comCitacoes(texto: string, fontes: FonteDTO[]) {
  return texto.replace(/\[(\d+)\]/g, (marca, n: string) => {
    const f = fontes.find((x) => x.indice === Number(n));
    return f ? `[[${n}]](/registros/${f.codigo})` : marca;
  });
}

function Fonte({ f }: { f: FonteDTO }) {
  const prazo = prazoRevisao(f.revisarEm);
  return (
    <li>
      <Link to={`/registros/${f.codigo}`} className={css.fonte}>
        <span className={css.indice}>{f.indice}</span>
        <span className={css.fonteTexto}>
          <span className="suave pequeno mono">
            {f.codigo} · v{f.versao} · {nomeTipo(f.tipo)}
          </span>
          <span className={css.fonteTitulo}>{f.titulo}</span>
          {f.status !== "vigente" ? (
            <span className="pequeno" style={{ color: "var(--alerta-texto)" }}>
              {NOME_STATUS[f.status]}
            </span>
          ) : prazo && prazo.nivel !== "ok" ? (
            <span className="pequeno" style={{ color: prazo.nivel === "erro" ? "var(--erro)" : "var(--alerta-texto)" }}>
              {prazo.texto}
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function Resposta({ r }: { r: RespostaPerguntaDTO }) {
  const avisar = useAvisar();
  if (r.lacuna || (!r.resposta && !r.fontes.length)) {
    return (
      <article className="cartao">
        <p style={{ fontWeight: 500 }}>Ainda não há registro sobre isso.</p>
        <p className="suave" style={{ marginTop: 6 }}>
          A pergunta foi para a lista de lacunas, para alguém documentar.{" "}
          <Link to={`/registros/novo?titulo=${encodeURIComponent(r.pergunta)}`}>Documentar agora</Link>
        </p>
      </article>
    );
  }
  return (
    <article className={`cartao ${css.resposta}`}>
      <span className="suave pequeno">
        Baseado em {r.fontes.length} {r.fontes.length === 1 ? "registro" : "registros"}
      </span>
      {r.resposta ? (
        <Conteudo texto={comCitacoes(r.resposta, r.fontes)} />
      ) : (
        <p className="suave">A IA está indisponível agora. Os registros mais relevantes estão ao lado.</p>
      )}
      {r.avisos.map((a) => (
        <div key={a} className="aviso aviso-alerta">
          {a}
        </div>
      ))}
      {r.resposta && (
        <div className={css.acoes}>
          <button
            type="button"
            className="botao botao-pequeno"
            onClick={() =>
              void navigator.clipboard.writeText(r.resposta!).then(
                () => avisar("Resposta copiada."),
                () => avisar("Não consegui copiar.", "erro"),
              )
            }
          >
            <Copy size={14} aria-hidden="true" /> Copiar resposta
          </button>
        </div>
      )}
    </article>
  );
}

export default function Perguntar() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [rascunho, setRascunho] = useState("");
  const perguntar = usePerguntar();
  const ultima = useRef<string | null>(null);
  const campo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (q.length >= 3 && ultima.current !== q) {
      ultima.current = q;
      perguntar.mutate(q);
    }
    if (!q) campo.current?.focus();
  }, [q, perguntar]);

  function enviar(e: FormEvent) {
    e.preventDefault();
    const texto = rascunho.trim();
    if (texto.length < 3) return;
    setParams({ q: texto });
    setRascunho("");
  }

  const r = perguntar.data;
  return (
    <div className={pg.pagina}>
      <div className={pg.duasColunas}>
        <div className={css.coluna}>
          {q ? (
            <header className={pg.titulos}>
              <span className="suave pequeno">Sua pergunta</span>
              <h1 className={css.pergunta}>{q}</h1>
            </header>
          ) : (
            <header className={pg.titulos}>
              <h1>Perguntar</h1>
              <p className="suave">Respostas só com o que está registrado e vigente, sempre com a fonte.</p>
            </header>
          )}

          {perguntar.isPending && (
            <article className="cartao" aria-live="polite">
              <span className="suave pequeno">Procurando nos registros…</span>
              <Esqueleto linhas={4} />
            </article>
          )}
          {perguntar.isError && <MensagemErro erro={perguntar.error} aoTentar={() => perguntar.mutate(q)} />}
          {r && !perguntar.isPending && <Resposta r={r} />}

          <form role="search" onSubmit={enviar} className={css.continuar}>
            <label htmlFor="nova" className="rotulo">
              {q ? "Continuar perguntando" : "Sua pergunta"}
            </label>
            <div className={css.linhaForm}>
              <div className={css.caixa}>
                <Search size={16} aria-hidden="true" className="suave" />
                <input
                  ref={campo}
                  id="nova"
                  className={css.entrada}
                  value={rascunho}
                  onChange={(e) => setRascunho(e.target.value)}
                  placeholder="ex.: qual a política de multa por atraso?"
                  autoComplete="off"
                />
              </div>
              <button type="submit" className="botao botao-primario" disabled={rascunho.trim().length < 3}>
                Perguntar
              </button>
            </div>
          </form>
        </div>

        {r && r.fontes.length > 0 && !perguntar.isPending && (
          <aside aria-labelledby="t-fontes" className={pg.secao}>
            <h2 id="t-fontes">Fontes</h2>
            <ol className={`lista ${css.fontes}`}>
              {r.fontes.map((f) => (
                <Fonte key={f.registroId} f={f} />
              ))}
            </ol>
          </aside>
        )}
      </div>
    </div>
  );
}
