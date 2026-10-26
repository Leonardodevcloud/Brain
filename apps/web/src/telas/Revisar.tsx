import type { AtaDados, RegistroDTO, RegistroResumoDTO } from "@cerebro/core/publico";
import { ArrowLeft, Check, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAcaoRegistro, useLacunas, useRegistro, useRegistros, useResolverLacuna } from "../api/consultas";
import { EtiquetaTipo, Esqueleto, MensagemErro, Vazio, textoDoErro, useAvisar } from "../componentes/comum";
import { Conteudo } from "../componentes/Conteudo";
import { useUsuario } from "../sessao/Sessao";
import { NOME_ORIGEM, dataCurta, nomeTipo, prazoRevisao, relativo } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Revisar.module.css";

type Aba = "aprovar" | "vencidos" | "lacunas";

function ItemFila({ r, ativo }: { r: RegistroResumoDTO; ativo: boolean }) {
  const prazo = r.status === "revisar" ? prazoRevisao(r.revisarEm) : null;
  return (
    <li>
      <Link to={`/revisar/${r.id}`} className={`${css.item} ${ativo ? css.itemAtivo : ""}`} aria-current={ativo ? "true" : undefined}>
        <span className={css.itemMeta}>
          <span>
            {nomeTipo(r.tipo)} · {NOME_ORIGEM[r.origem]}
          </span>
          <span>{prazo ? prazo.texto : relativo(r.atualizadoEm)}</span>
        </span>
        <span className={css.itemTitulo}>{r.titulo}</span>
      </Link>
    </li>
  );
}

/** Ata: escolhe quais decisões viram registro e quais pendências viram tarefas do Cérebro. */
function DetalheAta({ r }: { r: RegistroDTO }) {
  const ata = r.dados as unknown as AtaDados;
  const [decisoes, setDecisoes] = useState(() => new Set(ata.decisoes.map((d, i) => (d.aprovar ? i : -1)).filter((i) => i >= 0)));
  const [pendencias, setPendencias] = useState(() => new Set(ata.pendencias.map((p, i) => ((p.criarTarefa ?? p.criarNoNotion ?? true) ? i : -1)).filter((i) => i >= 0)));
  const alternar = (conjunto: Set<number>, definir: (s: Set<number>) => void, i: number) => {
    const n = new Set(conjunto);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    definir(n);
  };

  return (
    <>
      <section className={css.bloco}>
        <h3>Resumo</h3>
        <p>{ata.resumo}</p>
      </section>

      <section className={css.bloco}>
        <h3>Decisões</h3>
        {ata.decisoes.length ? (
          <div className={css.opcoes}>
            {ata.decisoes.map((d, i) => (
              <label key={i} className={css.opcao}>
                <input type="checkbox" checked={decisoes.has(i)} onChange={() => alternar(decisoes, setDecisoes, i)} />
                <span>
                  <span style={{ fontWeight: 500 }}>{d.texto}</span>
                  <span className="ajuda" style={{ display: "block" }}>
                    Vira um registro de Decisão
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="suave">Nenhuma decisão identificada.</p>
        )}
      </section>

      <section className={css.bloco}>
        <div className={pg.cabecalhoSecao}>
          <h3>Viram tarefas</h3>
        </div>
        {ata.pendencias.length ? (
          <div className={css.rolagem}>
            <table className={css.tabela}>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="so-leitor">Criar</span>
                  </th>
                  <th scope="col">Tarefa</th>
                  <th scope="col">Responsável</th>
                  <th scope="col">Prazo</th>
                </tr>
              </thead>
              <tbody>
                {ata.pendencias.map((p, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Criar a tarefa: ${p.tarefa}`}
                        checked={pendencias.has(i)}
                        onChange={() => alternar(pendencias, setPendencias, i)}
                      />
                    </td>
                    <td>{p.tarefa}</td>
                    <td className={p.responsavel ? "" : "suave"}>{p.responsavel ?? "Sem responsável"}</td>
                    <td className="mono">{p.prazo ? dataCurta(p.prazo).slice(0, 5) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="suave">Nenhuma pendência identificada.</p>
        )}
      </section>

      <p className={`suave pequeno ${css.mascara}`}>
        <ShieldCheck size={14} aria-hidden="true" /> Dados pessoais da transcrição foram mascarados antes de ir para a IA.
      </p>
      <Acoes r={r} decisoes={[...decisoes]} pendencias={[...pendencias]} />
    </>
  );
}

function Acoes({ r, decisoes, pendencias }: { r: RegistroDTO; decisoes?: number[]; pendencias?: number[] }) {
  const acao = useAcaoRegistro();
  const avisar = useAvisar();
  const navegar = useNavigate();
  const usuario = useUsuario();
  const [confirmarDescarte, setConfirmarDescarte] = useState(false);
  const ehAta = r.tipo === "reuniao";
  const soAdmin = (r.tipo === "politica" || r.tipo === "decisao") && usuario.papel !== "admin";

  const executar = (tipo: "aprovar" | "descartar" | "revisado", corpo?: unknown, mensagem?: string) =>
    acao.mutate(
      { id: r.id, acao: tipo, corpo },
      {
        onSuccess: () => {
          avisar(mensagem ?? "Feito.");
          navegar("/revisar", { replace: true });
        },
        onError: (erro) => avisar(textoDoErro(erro), "erro"),
      },
    );

  if (r.status === "revisar") {
    return (
      <div className={css.barraAcoes}>
        <Link to={`/registros/${r.codigo}/editar`} className="botao">
          Editar
        </Link>
        <button type="button" className="botao botao-primario" disabled={acao.isPending} onClick={() => executar("revisado", undefined, `${r.codigo} confirmado.`)}>
          <Check size={16} aria-hidden="true" /> Confirmar que segue válido
        </button>
      </div>
    );
  }

  const tarefas = pendencias?.length ?? 0;
  const rotulo = ehAta ? (tarefas ? `Aprovar e criar ${tarefas} ${tarefas === 1 ? "tarefa" : "tarefas"}` : "Aprovar ata") : "Aprovar";

  return (
    <div className={css.barraAcoes}>
      {confirmarDescarte ? (
        <>
          <span className="pequeno" style={{ flexGrow: 1 }}>
            Descartar {ehAta ? "esta ata" : r.codigo}? Ela sai da fila e não vira conhecimento.
          </span>
          <button type="button" className="botao botao-fantasma" onClick={() => setConfirmarDescarte(false)}>
            Manter
          </button>
          <button type="button" className="botao botao-perigo" disabled={acao.isPending} onClick={() => executar("descartar", undefined, "Descartado.")}>
            Descartar {ehAta ? "ata" : r.codigo}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="botao botao-fantasma botao-perigo" onClick={() => setConfirmarDescarte(true)}>
            Descartar
          </button>
          <span style={{ flexGrow: 1 }} />
          {!ehAta && (
            <Link to={`/registros/${r.codigo}/editar`} className="botao">
              Editar
            </Link>
          )}
          <button
            type="button"
            className="botao botao-primario"
            disabled={acao.isPending || soAdmin}
            title={soAdmin ? "Regras e decisões são aprovadas pelo administrador." : undefined}
            onClick={() => executar("aprovar", ehAta ? { decisoes, pendencias } : {}, `${r.codigo} aprovado.`)}
          >
            {acao.isPending ? "Aprovando…" : rotulo}
          </button>
        </>
      )}
    </div>
  );
}

function Detalhe({ id }: { id: string }) {
  const consulta = useRegistro(id);
  if (consulta.isError) return <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />;
  const r = consulta.data;
  if (!r) return <Esqueleto linhas={8} />;
  const ehAta = r.tipo === "reuniao";

  return (
    <article className={`cartao ${css.detalhe}`}>
      <header className={css.cabecalhoDetalhe}>
        <div className={css.metaDetalhe}>
          <EtiquetaTipo tipo={r.tipo} />
          <span className="suave pequeno">
            {NOME_ORIGEM[r.origem]} · {relativo(r.criadoEm)}
            {r.status === "revisar" && r.revisarEm && ` · revisão vencida em ${dataCurta(r.revisarEm)}`}
          </span>
        </div>
        <h2 className={css.tituloDetalhe}>{r.titulo}</h2>
        {r.fonteUrl && (
          <a href={r.fonteUrl} target="_blank" rel="noreferrer noopener" className="pequeno">
            {ehAta ? "Abrir a gravação" : "Abrir a origem"}
          </a>
        )}
      </header>
      {ehAta && r.status === "rascunho" && Array.isArray((r.dados as { decisoes?: unknown }).decisoes) ? (
        <DetalheAta r={r} />
      ) : (
        <>
          <Conteudo texto={r.conteudo} />
          {typeof r.dados.motivo === "string" && (
            <p className="aviso pequeno">Por que a IA sugeriu: {r.dados.motivo}</p>
          )}
          <Acoes r={r} />
        </>
      )}
    </article>
  );
}

function Lacunas() {
  const lacunas = useLacunas();
  const resolver = useResolverLacuna();
  if (lacunas.isError) return <MensagemErro erro={lacunas.error} />;
  if (!lacunas.data) return <Esqueleto />;
  if (!lacunas.data.length) return <Vazio titulo="Nenhuma lacuna aberta." texto="Toda pergunta sem resposta registrada aparece aqui." />;
  return (
    <ul className={`lista cartao ${css.lacunas}`}>
      {lacunas.data.map((l) => (
        <li key={l.id} className={css.lacuna}>
          <div className={css.lacunaTexto}>
            <span style={{ fontWeight: 500 }}>{l.pergunta}</span>
            <span className="suave pequeno">
              {l.canal === "mcp" ? "No Claude" : "No Cérebro"} · {relativo(l.criadoEm)}
            </span>
          </div>
          <div className={pg.acoes}>
            <Link to={`/registros/novo?titulo=${encodeURIComponent(l.pergunta)}`} className="botao botao-pequeno">
              Documentar
            </Link>
            <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => resolver.mutate(l.id)}>
              Dispensar
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Revisar() {
  const { id } = useParams();
  const [aba, setAba] = useState<Aba>("aprovar");
  const rascunhos = useRegistros({ status: "rascunho", porPagina: 50 });
  const vencidos = useRegistros({ status: "revisar", porPagina: 50 });
  const lacunas = useLacunas();
  const lista = aba === "aprovar" ? rascunhos : vencidos;

  const abas: { chave: Aba; rotulo: string; total?: number }[] = [
    { chave: "aprovar", rotulo: "Aprovar", total: rascunhos.data?.total },
    { chave: "vencidos", rotulo: "Revisão vencida", total: vencidos.data?.total },
    { chave: "lacunas", rotulo: "Lacunas", total: lacunas.data?.length },
  ];

  return (
    <div className={`${pg.pagina} ${css.pagina}`}>
      <div className={`${css.divisao} ${id ? css.comDetalhe : ""}`}>
        <section className={css.fila} aria-labelledby="t-revisar">
          <div className={pg.titulos}>
            <h1 id="t-revisar">Revisar</h1>
            <span className="suave pequeno">Nada vira vigente sem aprovação</span>
          </div>
          <div className={css.abas} role="tablist">
            {abas.map((a) => (
              <button
                key={a.chave}
                type="button"
                role="tab"
                aria-selected={aba === a.chave}
                className={`${css.aba} ${aba === a.chave ? css.abaAtiva : ""}`}
                onClick={() => setAba(a.chave)}
              >
                {a.rotulo}
                {a.total ? <span className={css.total}>{a.total}</span> : null}
              </button>
            ))}
          </div>
          {aba === "lacunas" ? null : lista.isError ? (
            <MensagemErro erro={lista.error} />
          ) : !lista.data ? (
            <Esqueleto linhas={5} altura={36} />
          ) : lista.data.itens.length ? (
            <ul className={`lista ${css.listaFila}`}>
              {lista.data.itens.map((r) => (
                <ItemFila key={r.id} r={r} ativo={r.id === id} />
              ))}
            </ul>
          ) : (
            <Vazio titulo={aba === "aprovar" ? "Nada esperando aprovação." : "Nenhum registro com revisão vencida."} />
          )}
        </section>

        <div className={css.painel}>
          {aba === "lacunas" ? (
            <Lacunas />
          ) : id ? (
            <>
              <Link to="/revisar" className={`${pg.voltar} ${css.voltarCelular}`}>
                <ArrowLeft size={14} aria-hidden="true" /> Fila
              </Link>
              <Detalhe id={id} />
            </>
          ) : (
            <div className={css.semSelecao}>
              <p className="suave">Escolha um item da fila para revisar.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
