import type { RegistroDTO, TipoRelacao } from "@cerebro/core/publico";
import { ArrowLeft, Check, ExternalLink, Pencil } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { useAcaoRegistro, useRegistro } from "../api/consultas";
import { EtiquetaStatus, Esqueleto, MensagemErro, Vazio, textoDoErro, useAvisar } from "../componentes/comum";
import { Conteudo } from "../componentes/Conteudo";
import { NOME_ORIGEM, dataCurta, nomeArea, nomeTipo, prazoRevisao } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Registro.module.css";

const NOME_RELACAO: Record<TipoRelacao, { saida: string; entrada: string }> = {
  referencia: { saida: "Referencia", entrada: "Referenciado por" },
  implementa: { saida: "Implementa", entrada: "Implementado por" },
  substitui: { saida: "Substitui", entrada: "Substituído por" },
  contradiz: { saida: "Contradiz", entrada: "Contradito por" },
};

const NOME_EMPRESA: Record<string, string> = { todas: "Todas", tutts: "Tutts", fiix: "Fiix", ig: "IG" };

function Relacoes({ r }: { r: RegistroDTO }) {
  const grupos = new Map<string, RegistroDTO["relacoes"]>();
  for (const rel of r.relacoes) {
    const nome = NOME_RELACAO[rel.tipo][rel.sentido];
    grupos.set(nome, [...(grupos.get(nome) ?? []), rel]);
  }
  if (!grupos.size) return <p className="suave pequeno">Nenhuma relação registrada.</p>;
  return (
    <div className={css.relacoes}>
      {[...grupos].map(([nome, itens]) => (
        <div key={nome} className={css.grupo}>
          <span className="suave pequeno">{nome}</span>
          {itens.map((rel) => (
            <Link key={rel.registro.id} to={`/registros/${rel.registro.codigo}`} className={css.relacao}>
              <span className="mono">{rel.registro.codigo}</span> · {rel.registro.titulo}
              {rel.registro.status === "obsoleto" && <span className="suave"> (obsoleto)</span>}
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}

function TornarObsoleto({ r }: { r: RegistroDTO }) {
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const acao = useAcaoRegistro();
  const avisar = useAvisar();
  if (!aberto) {
    return (
      <button type="button" className="botao botao-fantasma botao-pequeno botao-perigo" onClick={() => setAberto(true)}>
        Marcar como obsoleto
      </button>
    );
  }
  return (
    <form
      className={css.obsoleto}
      onSubmit={(e) => {
        e.preventDefault();
        acao.mutate(
          { id: r.id, acao: "obsoleto", corpo: { motivo } },
          {
            onSuccess: () => {
              avisar(`${r.codigo} marcado como obsoleto.`);
              setAberto(false);
            },
            onError: (erro) => avisar(textoDoErro(erro), "erro"),
          },
        );
      }}
    >
      <div className="campo">
        <label htmlFor="motivo-obsoleto">Por que {r.codigo} deixa de valer?</label>
        <input id="motivo-obsoleto" className="entrada" value={motivo} onChange={(e) => setMotivo(e.target.value)} autoFocus />
        <span className="ajuda">Ele sai das respostas, mas o histórico fica guardado.</span>
      </div>
      <div className={pg.acoes}>
        <button type="submit" className="botao botao-pequeno botao-perigo" disabled={motivo.trim().length < 3 || acao.isPending}>
          Marcar {r.codigo} como obsoleto
        </button>
        <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => setAberto(false)}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

export default function Registro() {
  const { id } = useParams();
  const consulta = useRegistro(id);
  const acao = useAcaoRegistro();
  const avisar = useAvisar();
  const navegar = useNavigate();

  if (consulta.isError) {
    const naoExiste = consulta.error instanceof ErroApi && consulta.error.status === 404;
    return (
      <div className={pg.pagina}>
        {naoExiste ? (
          <Vazio
            titulo={`Não encontrei ${id}.`}
            texto="Ele pode ter sido descartado ou o código está diferente."
            acao={
              <Link to="/biblioteca" className="botao">
                Ir para a biblioteca
              </Link>
            }
          />
        ) : (
          <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />
        )}
      </div>
    );
  }
  const r = consulta.data;
  if (!r) {
    return (
      <div className={pg.pagina}>
        <Esqueleto linhas={10} />
      </div>
    );
  }

  const prazo = prazoRevisao(r.revisarEm);
  const precisaRevisar = r.status === "revisar" || (r.status === "vigente" && prazo && prazo.nivel !== "ok");

  return (
    <div className={pg.pagina}>
      <Link to="/biblioteca" className={pg.voltar}>
        <ArrowLeft size={14} aria-hidden="true" /> Biblioteca
      </Link>

      <header className={pg.cabecalho}>
        <div className={pg.titulos}>
          <div className={css.meta}>
            <span className="mono">{r.codigo}</span>
            <EtiquetaStatus status={r.status} />
            <span className="suave pequeno">
              v{r.versao} · atualizado em {dataCurta(r.atualizadoEm)}
            </span>
          </div>
          <h1>{r.titulo}</h1>
        </div>
        <div className={pg.acoes}>
          {r.status === "rascunho" ? (
            <Link to={`/revisar/${r.id}`} className="botao botao-primario">
              Revisar e aprovar
            </Link>
          ) : (
            <>
              {(r.status === "vigente" || r.status === "revisar") && (
                <Link to={`/registros/${r.codigo}/editar`} className="botao">
                  <Pencil size={14} aria-hidden="true" /> Editar
                </Link>
              )}
              {precisaRevisar && (
                <button
                  type="button"
                  className="botao botao-primario"
                  disabled={acao.isPending}
                  onClick={() =>
                    acao.mutate(
                      { id: r.id, acao: "revisado" },
                      {
                        onSuccess: (novo) => avisar(`Confirmado. Próxima revisão em ${dataCurta(novo.revisarEm)}.`),
                        onError: (erro) => avisar(textoDoErro(erro), "erro"),
                      },
                    )
                  }
                >
                  <Check size={16} aria-hidden="true" /> Confirmar que segue válido
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {r.status === "obsoleto" && (
        <div className="aviso">Este registro está obsoleto e não aparece nas respostas. {r.relacoes.find((x) => x.tipo === "substitui" && x.sentido === "entrada") && "Veja quem o substituiu em Relações."}</div>
      )}

      <div className={pg.duasColunas}>
        <article className="cartao">
          <Conteudo texto={r.conteudo} />
          {r.fonteUrl && (
            <a href={r.fonteUrl} target="_blank" rel="noreferrer noopener" className={css.fonteExterna}>
              <ExternalLink size={14} aria-hidden="true" /> Abrir a origem
            </a>
          )}
        </article>

        <aside className={css.lateral}>
          <section className={pg.secao}>
            <h2>Detalhes</h2>
            <dl className={css.detalhes}>
              <dt>Tipo</dt>
              <dd>{nomeTipo(r.tipo)}</dd>
              <dt>Dono</dt>
              <dd>{r.dono?.nome ?? "—"}</dd>
              <dt>Área</dt>
              <dd>{nomeArea(r.area)}</dd>
              <dt>Empresa</dt>
              <dd>{NOME_EMPRESA[r.empresa] ?? r.empresa}</dd>
              {r.clienteRef && (
                <>
                  <dt>Cliente</dt>
                  <dd>{r.clienteRef}</dd>
                </>
              )}
              <dt>Revisar em</dt>
              <dd style={{ color: prazo?.nivel === "erro" ? "var(--erro)" : prazo?.nivel === "alerta" ? "var(--alerta-texto)" : undefined }}>
                {dataCurta(r.revisarEm)}
              </dd>
              <dt>Origem</dt>
              <dd>{NOME_ORIGEM[r.origem]}</dd>
              <dt>Acesso</dt>
              <dd>{r.confidencialidade === "restrito" ? "Restrito" : "Interno"}</dd>
            </dl>
          </section>

          <section className={pg.secao}>
            <h2>Relações</h2>
            <Relacoes r={r} />
          </section>

          <section className={pg.secao}>
            <h2>Histórico</h2>
            <ol className={`lista ${css.historico}`}>
              {r.versoes.map((v) => (
                <li key={v.versao}>
                  <span className={`mono ${css.versao}`}>v{v.versao}</span>
                  <span>
                    {v.motivo}
                    <span className="suave"> · {dataCurta(v.criadoEm)}</span>
                    {v.autor && <span className="suave"> · {v.autor}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {(r.status === "vigente" || r.status === "revisar") && <TornarObsoleto r={r} />}
          {r.status === "obsoleto" && (
            <button type="button" className="botao botao-pequeno" onClick={() => navegar(`/registros/novo?tipo=${r.tipo}&substitui=${r.id}`)}>
              Escrever um substituto
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}
