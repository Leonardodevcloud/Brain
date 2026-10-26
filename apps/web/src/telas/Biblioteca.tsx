import { AREAS, STATUS_REGISTRO, TIPOS_REGISTRO, type Area, type StatusRegistro, type TipoRegistro } from "@cerebro/core/publico";
import { Plus, Search, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useRegistros } from "../api/consultas";
import { EnviarDocumentos } from "../componentes/EnviarDocumentos";
import { EtiquetaStatus, EtiquetaTipo, Esqueleto, MensagemErro, Vazio, useAtraso } from "../componentes/comum";
import { NOME_STATUS, dataCurta, nomeArea, nomeTipo, prazoRevisao } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Biblioteca.module.css";

const POR_PAGINA = 30;

export default function Biblioteca() {
  const [params, setParams] = useSearchParams();
  const tipo = (params.get("tipo") ?? undefined) as TipoRegistro | undefined;
  const status = (params.get("status") ?? undefined) as StatusRegistro | undefined;
  const area = (params.get("area") ?? undefined) as Area | undefined;
  const pagina = Number(params.get("pagina") ?? 1);
  const [texto, setTexto] = useState(params.get("texto") ?? "");
  const [enviando, setEnviando] = useState(params.get("enviar") === "1");

  // Busca enquanto digita, com uma pequena espera.
  useEffect(() => {
    const t = setTimeout(() => mudar("texto", texto.trim() || undefined), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto]);

  function mudar(chave: string, valor: string | undefined) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (valor) n.set(chave, valor);
        else n.delete(chave);
        if (chave !== "pagina") n.delete("pagina");
        return n;
      },
      { replace: true },
    );
  }

  const consulta = useRegistros({ tipo, status, area, texto: params.get("texto") ?? undefined, pagina, porPagina: POR_PAGINA });
  const mostrarCarregando = useAtraso(consulta.isFetching && !consulta.isPlaceholderData);
  const d = consulta.data;
  const filtrando = Boolean(tipo || status || area || params.get("texto"));
  const paginas = d ? Math.max(1, Math.ceil(d.total / POR_PAGINA)) : 1;

  return (
    <div className={pg.pagina}>
      <header className={pg.cabecalho}>
        <div className={pg.titulos}>
          <h1>Biblioteca</h1>
          <p className="suave">{d ? `${d.total} ${d.total === 1 ? "registro" : "registros"}` : " "}</p>
        </div>
        <div className={pg.acoes}>
          <button type="button" className="botao" aria-expanded={enviando} onClick={() => setEnviando((v) => !v)}>
            <Upload size={16} aria-hidden="true" /> Enviar documentos
          </button>
          <Link to="/registros/novo" className="botao botao-primario">
            <Plus size={16} aria-hidden="true" /> Novo registro
          </Link>
        </div>
      </header>

      {enviando && <EnviarDocumentos aoFechar={() => setEnviando(false)} />}

      <div className={css.filtros} role="group" aria-label="Filtros">
        <div className={css.buscaTexto}>
          <Search size={16} aria-hidden="true" className="suave" />
          <label htmlFor="filtro-texto" className="so-leitor">
            Filtrar por texto
          </label>
          <input
            id="filtro-texto"
            className={css.entrada}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Título ou código (POP-014)"
          />
        </div>
        <label className="so-leitor" htmlFor="f-tipo">
          Tipo
        </label>
        <select id="f-tipo" className="selecao" value={tipo ?? ""} onChange={(e) => mudar("tipo", e.target.value || undefined)}>
          <option value="">Todos os tipos</option>
          {TIPOS_REGISTRO.map((t) => (
            <option key={t} value={t}>
              {nomeTipo(t)}
            </option>
          ))}
        </select>
        <label className="so-leitor" htmlFor="f-status">
          Status
        </label>
        <select id="f-status" className="selecao" value={status ?? ""} onChange={(e) => mudar("status", e.target.value || undefined)}>
          <option value="">Todos os status</option>
          {STATUS_REGISTRO.map((s) => (
            <option key={s} value={s}>
              {NOME_STATUS[s]}
            </option>
          ))}
        </select>
        <label className="so-leitor" htmlFor="f-area">
          Área
        </label>
        <select id="f-area" className="selecao" value={area ?? ""} onChange={(e) => mudar("area", e.target.value || undefined)}>
          <option value="">Todas as áreas</option>
          {AREAS.map((a) => (
            <option key={a} value={a}>
              {nomeArea(a)}
            </option>
          ))}
        </select>
      </div>

      {consulta.isError ? (
        <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />
      ) : !d || mostrarCarregando ? (
        <div className="cartao">
          <Esqueleto linhas={8} altura={18} />
        </div>
      ) : d.itens.length === 0 ? (
        filtrando ? (
          <Vazio
            titulo="Nenhum registro com esses filtros."
            acao={
              <button type="button" className="botao botao-pequeno" onClick={() => (setTexto(""), setParams({}))}>
                Limpar filtros
              </button>
            }
          />
        ) : (
          <Vazio
            titulo="A biblioteca está vazia."
            texto="Comece pelo procedimento que mais gera dúvida na operação."
            acao={
              <Link to="/registros/novo?tipo=pop" className="botao botao-primario">
                Escrever o primeiro POP
              </Link>
            }
          />
        )
      ) : (
        <>
          <div className={css.tabela} role="table" aria-label="Registros">
            <div role="row" className={`${css.linha} ${css.cabecalhoTabela}`}>
              <span role="columnheader">Registro</span>
              <span role="columnheader">Tipo</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Dono</span>
              <span role="columnheader">Revisão</span>
            </div>
            {d.itens.map((r) => {
              const prazo = prazoRevisao(r.revisarEm);
              return (
                <Link key={r.id} to={`/registros/${r.codigo}`} role="row" className={css.linha}>
                  <span role="cell" className={css.celulaTitulo}>
                    <span className="mono suave pequeno">{r.codigo}</span>
                    <span className={css.titulo}>{r.titulo}</span>
                  </span>
                  <span role="cell">
                    <EtiquetaTipo tipo={r.tipo} />
                  </span>
                  <span role="cell">
                    <EtiquetaStatus status={r.status} />
                  </span>
                  <span role="cell" className={`suave ${css.opcional}`}>
                    {r.dono?.nome ?? "—"}
                  </span>
                  <span
                    role="cell"
                    className={`pequeno ${css.opcional}`}
                    style={{ color: prazo?.nivel === "erro" ? "var(--erro)" : prazo?.nivel === "alerta" ? "var(--alerta-texto)" : "var(--texto-suave)" }}
                  >
                    {r.revisarEm ? (prazo?.nivel === "ok" ? dataCurta(r.revisarEm) : prazo?.texto) : "—"}
                  </span>
                </Link>
              );
            })}
          </div>
          {paginas > 1 && (
            <nav aria-label="Paginação" className={css.paginacao}>
              <button type="button" className="botao botao-pequeno" disabled={pagina <= 1} onClick={() => mudar("pagina", String(pagina - 1))}>
                Anterior
              </button>
              <span className="suave pequeno">
                Página {pagina} de {paginas}
              </span>
              <button
                type="button"
                className="botao botao-pequeno"
                disabled={pagina >= paginas}
                onClick={() => mudar("pagina", String(pagina + 1))}
              >
                Próxima
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
