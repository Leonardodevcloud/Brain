import type { RegistroResumoDTO } from "@cerebro/core/publico";
import { Search } from "lucide-react";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useInicio } from "../api/consultas";
import { EtiquetaTipo, Esqueleto, MensagemErro, useAtalho } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { NOME_ORIGEM, dataLonga, diasAte, hora, prazoRevisao, relativo, saudacao } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Inicio.module.css";

function rotuloDia(iso: string) {
  const d = diasAte(new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Bahia" }));
  return d === 0 ? "Hoje" : d === 1 ? "Amanhã" : new Date(iso).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit" });
}

function ItemRevisar({ r }: { r: RegistroResumoDTO }) {
  return (
    <li className={css.linha}>
      <EtiquetaTipo tipo={r.tipo} />
      <div className={css.texto}>
        <Link to={`/revisar/${r.id}`} className={css.tituloLink}>
          {r.titulo}
        </Link>
        <span className="suave pequeno">
          {NOME_ORIGEM[r.origem]} · {relativo(r.atualizadoEm)}
        </span>
      </div>
    </li>
  );
}

function ItemAtencao({ r }: { r: RegistroResumoDTO }) {
  const prazo = prazoRevisao(r.revisarEm);
  const cor = prazo?.nivel === "erro" ? "var(--erro)" : "var(--alerta)";
  return (
    <li className={css.linha} style={{ alignItems: "center" }}>
      <span aria-hidden="true" className="ponto" style={{ background: cor }} />
      <div className={css.texto}>
        <Link to={`/registros/${r.codigo}`} className={css.tituloLink}>
          {r.codigo} · {r.titulo}
        </Link>
        <span className="pequeno" style={{ color: prazo?.nivel === "erro" ? "var(--erro)" : "var(--alerta-texto)" }}>
          {r.status === "revisar" ? "Em revisão" : prazo?.texto}
        </span>
      </div>
    </li>
  );
}

export function Inicio() {
  const usuario = useUsuario();
  const inicio = useInicio();
  const navegar = useNavigate();
  const [pergunta, setPergunta] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  useAtalho("/", useCallback(() => campo.current?.focus(), []));

  function perguntar(e: FormEvent) {
    e.preventDefault();
    if (pergunta.trim().length >= 3) navegar(`/perguntar?q=${encodeURIComponent(pergunta.trim())}`);
  }

  const d = inicio.data;
  const primeiroNome = usuario.nome.split(" ")[0];

  return (
    <div className={pg.pagina}>
      <header className={pg.titulos}>
        <span className="suave" style={{ fontSize: 13 }}>
          {dataLonga()}
        </span>
        <h1>
          {saudacao()}, {primeiroNome}
        </h1>
      </header>

      <form role="search" onSubmit={perguntar} className={css.busca}>
        <label htmlFor="pergunta" className="rotulo">
          Pergunte ao cérebro
        </label>
        <div className={css.caixaBusca}>
          <Search size={18} aria-hidden="true" className="suave" style={{ flexShrink: 0 }} />
          <input
            ref={campo}
            id="pergunta"
            className={css.entradaBusca}
            placeholder="ex.: como tratamos falta de motoboy pela manhã?"
            value={pergunta}
            onChange={(e) => setPergunta(e.target.value)}
            autoComplete="off"
          />
          <kbd className={css.tecla} aria-hidden="true">
            /
          </kbd>
          <button type="submit" className="botao botao-primario" disabled={pergunta.trim().length < 3}>
            Perguntar
          </button>
        </div>
      </form>

      {inicio.isError ? (
        <MensagemErro erro={inicio.error} aoTentar={() => void inicio.refetch()} />
      ) : (
        <section aria-label="Resumo de hoje" className={css.grade}>
          <article className="cartao">
            <div className={pg.cabecalhoSecao}>
              <h2>Para revisar</h2>
              <Link to="/revisar" className="pequeno">
                Ver todos
              </Link>
            </div>
            {!d ? (
              <Esqueleto />
            ) : d.paraRevisar.length ? (
              <ul className={`lista ${css.listaCartao}`}>
                {d.paraRevisar.map((r) => (
                  <ItemRevisar key={r.id} r={r} />
                ))}
              </ul>
            ) : (
              <p className={`suave ${css.vazio}`}>Nada esperando aprovação.</p>
            )}
          </article>

          <article className="cartao">
            <div className={pg.cabecalhoSecao}>
              <h2>Próximas reuniões</h2>
              <span className="suave pequeno">Google Agenda</span>
            </div>
            {!d ? (
              <Esqueleto />
            ) : d.proximasReunioes.length ? (
              <ul className={`lista ${css.listaCartao}`}>
                {d.proximasReunioes.map((m) => (
                  <li key={m.inicio + m.titulo} className={css.linha}>
                    <div className={css.horario}>
                      <span className="suave pequeno">{rotuloDia(m.inicio)}</span>
                      <span className="mono" style={{ fontWeight: 500 }}>
                        {hora(m.inicio)}
                      </span>
                    </div>
                    <div className={css.texto}>
                      <span style={{ fontWeight: 500 }}>{m.titulo}</span>
                      {m.link && (
                        <a href={m.link} target="_blank" rel="noreferrer" className="pequeno">
                          Abrir no Meet
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`suave ${css.vazio}`}>
                Nenhuma reunião nas próximas 36 h. <Link to="/integracoes">Conferir a agenda</Link>
              </p>
            )}
          </article>

          <article className="cartao">
            <div className={pg.cabecalhoSecao}>
              <h2>Precisam de atenção</h2>
              <span className="suave pequeno">Revisão vencida</span>
            </div>
            {!d ? (
              <Esqueleto />
            ) : d.vencidos.length ? (
              <ul className={`lista ${css.listaCartao}`}>
                {d.vencidos.map((r) => (
                  <ItemAtencao key={r.id} r={r} />
                ))}
              </ul>
            ) : (
              <p className={`suave ${css.vazio}`}>Tudo dentro do prazo de revisão.</p>
            )}
          </article>
        </section>
      )}

      <section className={pg.secao} aria-labelledby="t-atividade">
        <h2 id="t-atividade">Atividade recente</h2>
        {!d ? (
          <div className="cartao">
            <Esqueleto linhas={4} />
          </div>
        ) : d.atividade.length ? (
          <ol className={`lista cartao ${css.atividade}`}>
            {d.atividade.map((a, i) => (
              <li key={i} className={css.linhaAtividade}>
                <span className={`suave pequeno ${css.quando}`}>{relativo(a.quando)}</span>
                <span style={{ flexGrow: 1 }}>
                  {a.registroId ? <Link to={`/registros/${a.registroId}`}>{a.descricao}</Link> : a.descricao}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="cartao">
            <p className="suave">
              Ainda sem atividade. Comece <Link to="/registros/novo">criando o primeiro POP</Link> ou{" "}
              <Link to="/integracoes">conectando o Claude</Link>.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
