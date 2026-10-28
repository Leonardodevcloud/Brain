import type { RegistroDTO, TipoRelacao } from "@cerebro/core/publico";
import { ArrowLeft, Check, Download, ExternalLink, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { useAcaoRegistro, useRegistro } from "../api/consultas";
import { baixarOriginal, useCriarTarefa, useExcluirRegistro, useTarefas } from "../api/tarefas";
import { useUsuario } from "../sessao/Sessao";
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

const LIMITE_LEITURA = 20_000;

function tamanhoArquivo(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Documento enviado: o arquivo original fica disponível para baixar. */
function ArquivoOriginal({ r }: { r: RegistroDTO }) {
  const avisar = useAvisar();
  const [baixando, setBaixando] = useState(false);
  const arquivo = (r.dados as { arquivo?: { nome: string; tamanho: number } }).arquivo;
  if (!arquivo) return null;
  return (
    <div className={css.arquivo}>
      <FileText size={18} aria-hidden="true" />
      <span className={css.arquivoNome}>
        {arquivo.nome}
        <span className="suave pequeno"> · {tamanhoArquivo(arquivo.tamanho)}</span>
      </span>
      <button
        type="button"
        className="botao botao-pequeno"
        disabled={baixando}
        onClick={() => {
          setBaixando(true);
          baixarOriginal(r.id, arquivo.nome)
            .catch((e) => avisar(textoDoErro(e), "erro"))
            .finally(() => setBaixando(false));
        }}
      >
        <Download size={14} aria-hidden="true" /> {baixando ? "Baixando…" : "Baixar original"}
      </button>
    </div>
  );
}

/** Tarefas ligadas a este registro, e um jeito rápido de criar mais uma. */
function TarefasDoRegistro({ r }: { r: RegistroDTO }) {
  const tarefas = useTarefas("todas", "", r.id);
  const criar = useCriarTarefa();
  const avisar = useAvisar();
  const [titulo, setTitulo] = useState("");
  const abertas = (tarefas.data ?? []).filter((t) => t.status !== "feita");

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (titulo.trim().length < 2) return;
    criar.mutate(
      { titulo: titulo.trim(), registros: [r.id] },
      { onSuccess: (t) => (setTitulo(""), avisar(`${t.codigo} criada e ligada a ${r.codigo}.`)), onError: (erro) => avisar(textoDoErro(erro), "erro") },
    );
  }

  return (
    <section className={pg.secao}>
      <h2>Tarefas</h2>
      {abertas.length > 0 && (
        <ul className={`lista ${css.tarefas}`}>
          {abertas.map((t) => (
            <li key={t.id}>
              <Link to={`/tarefas?abrir=${t.codigo}`}>{t.titulo}</Link>
              <span className="suave pequeno" style={{ color: t.atrasada ? "var(--erro)" : undefined }}>
                {" "}
                · {t.status === "fazendo" ? "fazendo" : "a fazer"}
                {t.prazo ? ` · ${dataCurta(t.prazo)}` : ""}
                {t.responsavel ? ` · ${t.responsavel.nome}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={enviar} className={css.novaTarefa}>
        <label htmlFor="tarefa-registro" className="so-leitor">
          Nova tarefa ligada a {r.codigo}
        </label>
        <input id="tarefa-registro" className="entrada" placeholder="Nova tarefa ligada a este registro" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
        <button type="submit" className="botao botao-icone" aria-label="Criar tarefa" disabled={titulo.trim().length < 2 || criar.isPending}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
}

/** Excluir de vez (administrador): exige digitar o código. */
function ExcluirDeVez({ r }: { r: RegistroDTO }) {
  const [aberto, setAberto] = useState(false);
  const [codigo, setCodigo] = useState("");
  const excluir = useExcluirRegistro();
  const avisar = useAvisar();
  const navegar = useNavigate();
  if (!aberto) {
    return (
      <button type="button" className="botao botao-fantasma botao-pequeno botao-perigo" onClick={() => setAberto(true)}>
        <Trash2 size={14} aria-hidden="true" /> Excluir de vez
      </button>
    );
  }
  return (
    <form
      className={css.obsoleto}
      onSubmit={(e) => {
        e.preventDefault();
        excluir.mutate(
          { id: r.id, confirmacao: codigo },
          {
            onSuccess: () => {
              avisar(`${r.codigo} excluído.`);
              navegar("/biblioteca");
            },
            onError: (erro) => avisar(textoDoErro(erro), "erro"),
          },
        );
      }}
    >
      <div className="campo">
        <label htmlFor="confirmar-exclusao">
          Isso apaga {r.codigo} da busca, do Argos, do mapa e o arquivo enviado. Não dá para desfazer. Digite <b className="mono">{r.codigo}</b> para confirmar.
        </label>
        <input id="confirmar-exclusao" className="entrada mono" value={codigo} onChange={(e) => setCodigo(e.target.value)} autoComplete="off" autoFocus />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="botao botao-pequeno botao-perigo" disabled={codigo.trim().toUpperCase() !== r.codigo || excluir.isPending}>
          Excluir {r.codigo}
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
  const eu = useUsuario();
  const [tudo, setTudo] = useState(false);

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
                        onSuccess: (novo) =>
                          avisar(novo?.revisarEm ? `Confirmado. Próxima revisão em ${dataCurta(novo.revisarEm)}.` : "Confirmado: segue válido."),
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
          {r.tipo === "documento" && <ArquivoOriginal r={r} />}
          <Conteudo texto={tudo || r.conteudo.length <= LIMITE_LEITURA ? r.conteudo : `${r.conteudo.slice(0, LIMITE_LEITURA)}…`} />
          {r.conteudo.length > LIMITE_LEITURA && (
            <button type="button" className="botao botao-pequeno" onClick={() => setTudo((v) => !v)}>
              {tudo ? "Mostrar menos" : `Mostrar o documento inteiro (${Math.round(r.conteudo.length / 1000)} mil caracteres)`}
            </button>
          )}
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

          {r.status !== "descartado" && <TarefasDoRegistro r={r} />}

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
          {eu.papel === "admin" && <ExcluirDeVez r={r} />}
        </aside>
      </div>
    </div>
  );
}
