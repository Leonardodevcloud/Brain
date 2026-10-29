import {
  NOME_AREA,
  type Area,
  type MapaDTO,
  type TipoRegistro,
} from "@cerebro/core/publico";
import { useQuery } from "@tanstack/react-query";
import { forceCollide, forceX, forceY } from "d3-force";
import {
  ArrowRight,
  Maximize2,
  MessageCircle,
  Minus,
  Plus,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../api/cliente";
import { MensagemErro, useAtalho } from "../../componentes/comum";
import { NOME_STATUS, nomeTipo, relativo } from "../../util/formato";
import { COR_CLIENTE, COR_REVISAR, COR_TIPO } from "./cores";
import {
  areaDeClique,
  corDaLigacao,
  corDoNo,
  desenharNo,
  ehRelacaoExplicita,
  idDe,
  raio,
  type EstadoDesenho,
  type Ligacao,
  type No,
} from "./desenho";
import css from "./Mapa.module.css";

const NOME_LIGACAO: Record<string, string> = {
  referencia: "Referencia",
  implementa: "Implementa",
  substitui: "Substitui",
  contradiz: "Contradiz",
  semelhante: "Parecido",
  cliente: "Cliente",
  area: "Área",
};

// Folga ao enquadrar, para nada ficar sob o topo, a legenda ou o zoom (menor no celular).
const ehCelular = () => window.innerWidth <= 860;
const margemEnquadrar = () => (ehCelular() ? 36 : 120);
const LARGURA_PAINEL = 380;

const normalizarBusca = (t: string) =>
  t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const escaparHtml = (t: string) =>
  t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function useMovimentoReduzido() {
  const [reduzido, setReduzido] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ouvir = () => setReduzido(m.matches);
    m.addEventListener("change", ouvir);
    return () => m.removeEventListener("change", ouvir);
  }, []);
  return reduzido;
}

function useTamanho<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [tamanho, setTamanho] = useState({ largura: 0, altura: 0 });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const obs = new ResizeObserver(([e]) => {
      if (e)
        setTamanho({
          largura: Math.round(e.contentRect.width),
          altura: Math.round(e.contentRect.height),
        });
    });
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return [ref, tamanho] as const;
}

export default function Mapa() {
  const consulta = useQuery({
    queryKey: ["mapa"],
    queryFn: () => api<MapaDTO>("/mapa"),
    staleTime: 15_000,
  });
  const movimentoReduzido = useMovimentoReduzido();
  const movimento = !movimentoReduzido;
  const grafo = useRef<ForceGraphMethods<No, Ligacao> | undefined>(undefined);
  const [moldura, tamanho] = useTamanho<HTMLDivElement>();
  const campoBusca = useRef<HTMLInputElement>(null);

  const [apontado, setApontado] = useState<string | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [tipos, setTipos] = useState<Set<TipoRegistro>>(new Set());
  const [areasOcultas, setAreasOcultas] = useState<Set<Area>>(new Set());
  const [verParecidos, setVerParecidos] = useState(true);
  const [verRascunhos, setVerRascunhos] = useState(true);
  // Legenda aberta ou recolhida: lembrada neste navegador.
  const [legendaAberta, setLegendaAberta] = useState(() => {
    try {
      return (
        localStorage.getItem("cerebro.mapa.legenda") !== "0" && !ehCelular()
      );
    } catch {
      return !ehCelular();
    }
  });
  const alternarLegenda = () =>
    setLegendaAberta((v) => {
      try {
        localStorage.setItem("cerebro.mapa.legenda", v ? "0" : "1");
      } catch {
        /* sem armazenamento: vale só agora */
      }
      return !v;
    });

  // Objetos estáveis entre recargas e filtros: a simulação mantém as posições.
  const cacheNos = useRef(new Map<string, No>());
  const todos = useMemo(() => {
    const d = consulta.data;
    if (!d) return null;
    const nos = d.nos.map((n) => {
      const antigo = cacheNos.current.get(n.id);
      const novo = antigo ? Object.assign(antigo, n) : ({ ...n } as No);
      cacheNos.current.set(n.id, novo);
      return novo;
    });
    return {
      nos,
      ligacoes: d.ligacoes.map((l) => ({ ...l }) as Ligacao),
      dados: d,
    };
  }, [consulta.data]);

  const visiveis = useMemo(() => {
    if (!todos) return { nodes: [] as No[], links: [] as Ligacao[] };
    const ok = new Set<string>();
    for (const n of todos.nos) {
      if (n.area && areasOcultas.has(n.area)) continue;
      if (n.categoria === "registro") {
        if (tipos.size && n.tipo && !tipos.has(n.tipo)) continue;
        if (!verRascunhos && n.status === "rascunho") continue;
      }
      ok.add(n.id);
    }
    const links = todos.ligacoes.filter(
      (l) =>
        ok.has(idDe(l.origem)) &&
        ok.has(idDe(l.destino)) &&
        (verParecidos || l.tipo !== "semelhante"),
    );
    // Clientes sem nenhum registro visível somem.
    const comLigacao = new Set(
      links.flatMap((l) => [idDe(l.origem), idDe(l.destino)]),
    );
    const nodes = todos.nos.filter(
      (n) =>
        ok.has(n.id) && (n.categoria !== "cliente" || comLigacao.has(n.id)),
    );
    return { nodes, links };
  }, [todos, tipos, areasOcultas, verParecidos, verRascunhos]);

  const vizinhos = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const l of visiveis.links) {
      const a = idDe(l.origem);
      const b = idDe(l.destino);
      if (!m.has(a)) m.set(a, new Set());
      if (!m.has(b)) m.set(b, new Set());
      m.get(a)!.add(b);
      m.get(b)!.add(a);
    }
    return m;
  }, [visiveis]);

  const foco = apontado ?? selecionado;
  const destaque = useMemo(() => {
    if (!foco) return new Set<string>();
    return new Set([foco, ...(vizinhos.get(foco) ?? [])]);
  }, [foco, vizinhos]);

  // O desenho lê um ref: muda a cada quadro sem recriar as funções do grafo.
  const estado = useRef<EstadoDesenho>({
    destaque,
    selecionado,
    tempo: 0,
    movimento,
  });
  estado.current.destaque = destaque;
  estado.current.selecionado = selecionado;
  estado.current.movimento = movimento;

  const ligacaoEmFoco = useCallback(
    (l: Ligacao) =>
      foco !== null && (idDe(l.origem) === foco || idDe(l.destino) === foco),
    [foco],
  );

  // Forças: áreas se afastam entre si, registros ficam perto da sua área, ninguém se sobrepõe.
  useEffect(() => {
    const g = grafo.current;
    if (!g || !visiveis.nodes.length) return;
    g.d3Force("charge")
      ?.strength((n: No) =>
        n.categoria === "area" ? -200 : n.categoria === "cliente" ? -70 : -34,
      )
      .distanceMax(420);
    g.d3Force("link")
      ?.distance((l: Ligacao) =>
        l.tipo === "area"
          ? 34 + Math.random() * 18
          : l.tipo === "semelhante"
            ? 70
            : 52,
      )
      .strength((l: Ligacao) =>
        l.tipo === "area" ? 0.55 : l.tipo === "semelhante" ? 0.12 : 0.35,
      );
    g.d3Force("collide", forceCollide<No>((n) => raio(n) + 2.5).iterations(2));
    // Gravidade leve: mantém ilhas soltas perto do conjunto.
    g.d3Force("x", forceX<No>(0).strength(0.045));
    g.d3Force("y", forceY<No>(0).strength(0.045));
    g.d3ReheatSimulation();
  }, [visiveis]);

  // Enquadra quando o mapa aparece pela primeira vez.
  const enquadrado = useRef(false);
  const assentou = useRef(false);
  useEffect(() => {
    if (!visiveis.nodes.length || enquadrado.current) return;
    const t = setTimeout(
      () => {
        grafo.current?.zoomToFit(movimento ? 900 : 0, margemEnquadrar());
        enquadrado.current = true;
      },
      movimento ? 1400 : 50,
    );
    return () => clearTimeout(t);
  }, [visiveis, movimento]);

  const irPara = useCallback(
    (id: string, zoom = 2.8) => {
      const no = cacheNos.current.get(id);
      if (!no || no.x === undefined || no.y === undefined) return;
      setSelecionado(id);
      const atual = grafo.current?.zoom() ?? 1;
      const alvo = Math.max(atual, zoom);
      // No desktop o painel cobre a direita: o nó fica no centro da área livre.
      // No celular a folha cobre a parte de baixo: o nó sobe.
      const dx = ehCelular() ? 0 : LARGURA_PAINEL / 2 / alvo;
      const dy = ehCelular() ? (window.innerHeight * 0.26) / alvo : 0;
      grafo.current?.centerAt(no.x + dx, no.y + dy, movimento ? 700 : 0);
      grafo.current?.zoom(alvo, movimento ? 700 : 0);
    },
    [movimento],
  );

  // Chegando com ?foco=<id> (ex.: "Argos, mostra no mapa a Rede Exemplo Norte").
  const [params, setParams] = useSearchParams();
  const focoUrl = params.get("foco");
  useEffect(() => {
    if (!focoUrl || !visiveis.nodes.length) return;
    const t = setTimeout(
      () => {
        irPara(focoUrl);
        setParams({}, { replace: true });
      },
      movimento ? 1900 : 100,
    );
    return () => clearTimeout(t);
  }, [focoUrl, visiveis, irPara, setParams, movimento]);

  const enquadrar = useCallback(
    () => grafo.current?.zoomToFit(movimento ? 600 : 0, margemEnquadrar()),
    [movimento],
  );
  useAtalho(
    "/",
    useCallback(() => campoBusca.current?.focus(), []),
  );
  useAtalho("f", enquadrar);
  useAtalho(
    "Escape",
    useCallback(() => setSelecionado(null), []),
  );

  const resultados = useMemo(() => {
    const q = normalizarBusca(busca.trim());
    if (q.length < 2 || !todos) return [];
    return todos.nos
      .filter((n) =>
        normalizarBusca(`${n.codigo ?? ""} ${n.rotulo}`).includes(q),
      )
      .sort((a, b) => b.grau - a.grau)
      .slice(0, 8);
  }, [busca, todos]);

  const desenhar = useCallback(
    (no: No, ctx: CanvasRenderingContext2D, escala: number) =>
      desenharNo(no, ctx, escala, estado.current),
    [],
  );
  const antesDoQuadro = useCallback(() => {
    if (estado.current.movimento)
      estado.current.tempo = performance.now() / 1000;
  }, []);

  if (consulta.isError) {
    return (
      <div className={css.tela}>
        <div className={css.centro}>
          <MensagemErro
            erro={consulta.error}
            aoTentar={() => void consulta.refetch()}
          />
        </div>
      </div>
    );
  }

  const d = todos?.dados;
  const totalRegistros =
    d?.nos.filter((n) => n.categoria === "registro").length ?? 0;
  const areasPresentes = [
    ...new Set(
      d?.nos.filter((n) => n.categoria === "area").map((n) => n.area!) ?? [],
    ),
  ];
  const tiposPresentes = [
    ...new Set(d?.nos.filter((n) => n.tipo).map((n) => n.tipo!) ?? []),
  ];
  const noSelecionado = selecionado
    ? cacheNos.current.get(selecionado)
    : undefined;
  const totalConexoes =
    d?.ligacoes.filter((l) => l.tipo !== "area").length ?? 0;
  const contagemTipo = new Map<TipoRegistro, number>();
  for (const n of d?.nos ?? [])
    if (n.tipo) contagemTipo.set(n.tipo, (contagemTipo.get(n.tipo) ?? 0) + 1);

  return (
    <div className={css.tela}>
      <div
        ref={moldura}
        className={css.canvas}
        aria-label="Mapa do conhecimento: registros ligados por área, cliente e assunto"
        role="img"
      >
        {tamanho.largura > 0 && visiveis.nodes.length > 0 && (
          <ForceGraph2D<No, Ligacao>
            ref={grafo}
            width={tamanho.largura}
            height={tamanho.altura}
            graphData={visiveis}
            linkSource="origem"
            linkTarget="destino"
            backgroundColor="rgba(0,0,0,0)"
            autoPauseRedraw={false}
            minZoom={0.3}
            maxZoom={8}
            warmupTicks={movimento ? 0 : 160}
            cooldownTicks={movimento ? 400 : 0}
            d3VelocityDecay={0.32}
            nodeCanvasObject={desenhar}
            nodePointerAreaPaint={areaDeClique}
            nodeLabel={(n) =>
              n.categoria === "registro"
                ? `<div class="${css.dica}"><b>${escaparHtml(n.codigo ?? "")}</b> · ${escaparHtml(nomeTipo(n.tipo!))}<br/>${escaparHtml(n.rotulo)}</div>`
                : ""
            }
            linkColor={(l) => corDaLigacao(l, destaque, ligacaoEmFoco(l))}
            linkWidth={(l) =>
              ligacaoEmFoco(l) ? 1.6 : ehRelacaoExplicita(l) ? 1.1 : 0.6
            }
            linkLineDash={(l) => (l.tipo === "semelhante" ? [3, 3] : null)}
            linkCurvature={(l) => (l.tipo === "semelhante" ? 0.18 : 0)}
            linkDirectionalArrowLength={(l) =>
              ehRelacaoExplicita(l) ? 3.2 : 0
            }
            linkDirectionalArrowRelPos={0.92}
            linkDirectionalParticles={(l) =>
              movimento && ligacaoEmFoco(l) ? 2 : 0
            }
            linkDirectionalParticleWidth={2.2}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleColor={() => "#A78BFA"}
            onRenderFramePre={antesDoQuadro}
            onEngineStop={() => {
              if (assentou.current) return;
              assentou.current = true;
              if (!selecionado)
                grafo.current?.zoomToFit(
                  movimento ? 700 : 0,
                  margemEnquadrar(),
                );
            }}
            onNodeHover={(n) => {
              setApontado(n?.id ?? null);
              if (moldura.current)
                moldura.current.style.cursor = n ? "pointer" : "grab";
            }}
            onNodeClick={(n) =>
              irPara(n.id, n.categoria === "area" ? 1.8 : 2.8)
            }
            onBackgroundClick={() => setSelecionado(null)}
          />
        )}
      </div>

      {/* ── Busca, filtros e números, flutuando sobre o mapa ── */}
      <header className={`${css.topo} ${noSelecionado ? css.topoComPainel : ""}`}>
        <h1 className="so-leitor">Mapa do conhecimento</h1>

        <div className={css.busca}>
          <Search size={15} aria-hidden="true" className={css.iconeBusca} />
          <label htmlFor="busca-mapa" className="so-leitor">
            Encontrar no mapa
          </label>
          <input
            ref={campoBusca}
            id="busca-mapa"
            className={css.entradaBusca}
            placeholder="Buscar POP, regra, cliente…"
            value={busca}
            autoComplete="off"
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && resultados[0]) {
                irPara(resultados[0].id);
                setBusca("");
                campoBusca.current?.blur();
              }
              if (e.key === "Escape") {
                setBusca("");
                campoBusca.current?.blur();
              }
            }}
          />
          <kbd className={css.tecla}>/</kbd>
          {resultados.length > 0 && (
            <ul
              className={css.resultados}
              role="listbox"
              aria-label="Resultados"
            >
              {resultados.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    className={css.resultado}
                    onClick={() => {
                      irPara(n.id);
                      setBusca("");
                    }}
                  >
                    <span
                      className={css.bolinha}
                      style={{ background: corDoNo(n) }}
                      aria-hidden="true"
                    />
                    <span className={css.resultadoTexto}>{n.rotulo}</span>
                    <span className={css.resultadoMeta}>
                      {n.codigo ??
                        (n.categoria === "area" ? "Área" : "Cliente")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={css.filtros} role="group" aria-label="Filtrar por tipo">
          <Pilula ativa={tipos.size === 0} onClick={() => setTipos(new Set())}>
            Tudo
          </Pilula>
          {tiposPresentes.map((t) => (
            <Pilula
              key={t}
              ativa={tipos.has(t)}
              onClick={() =>
                setTipos((atual) => {
                  const n = new Set(atual);
                  if (n.has(t)) n.delete(t);
                  else n.add(t);
                  return n;
                })
              }
            >
              {nomeTipo(t)}
            </Pilula>
          ))}
          <span className={css.separador} aria-hidden="true" />
          <Pilula
            opcao
            ativa={verParecidos}
            onClick={() => setVerParecidos((v) => !v)}
          >
            Parecidos
          </Pilula>
          <Pilula
            opcao
            ativa={verRascunhos}
            onClick={() => setVerRascunhos((v) => !v)}
          >
            Rascunhos
          </Pilula>
        </div>

        <p className={css.numeros} aria-live="polite">
          {d ? (
            <>
              <b>{totalRegistros}</b> registros · <b>{totalConexoes}</b> ligações
            </>
          ) : (
            "Montando o mapa…"
          )}
        </p>
      </header>

      {/* ── Legenda: tipos (contagem), áreas (clicáveis) e símbolos ── */}
      {areasPresentes.length > 0 && (
        <div className={css.legenda}>
          <div className={css.legendaTopo}>
            <span className={css.legendaTitulo}>Tipos</span>
            <button
              type="button"
              className={css.recolher}
              aria-expanded={legendaAberta}
              onClick={() => alternarLegenda()}
            >
              {legendaAberta ? "Recolher" : "Áreas e símbolos"}
            </button>
          </div>
          <div className={css.tiposLegenda}>
            {tiposPresentes.map((t) => (
              <span key={t} className={css.tipoLegenda}>
                <span
                  className={css.bolinha}
                  style={{ background: COR_TIPO[t] }}
                  aria-hidden="true"
                />
                {nomeTipo(t)} <small>{contagemTipo.get(t) ?? 0}</small>
              </span>
            ))}
          </div>
          {legendaAberta && (
            <>
              <span className={css.legendaTitulo}>Áreas</span>
              <div
                className={css.areas}
                role="group"
                aria-label="Mostrar ou esconder áreas"
              >
                {areasPresentes.map((a) => {
                  const oculta = areasOcultas.has(a);
                  return (
                    <button
                      key={a}
                      type="button"
                      className={`${css.area} ${oculta ? css.areaOculta : ""}`}
                      aria-pressed={!oculta}
                      onClick={() =>
                        setAreasOcultas((atual) => {
                          const n = new Set(atual);
                          if (n.has(a)) n.delete(a);
                          else n.add(a);
                          return n;
                        })
                      }
                    >
                      <span
                        className={css.bolinha}
                        style={{ background: "#A8A29E" }}
                        aria-hidden="true"
                      />
                      {NOME_AREA[a]}
                    </button>
                  );
                })}
              </div>
              <div className={css.simbolos} aria-hidden="true">
                <span>
                  <i className={css.simVigente} /> Vigente
                </span>
                <span>
                  <i className={css.simRascunho} /> Rascunho
                </span>
                <span>
                  <i
                    className={css.simRevisar}
                    style={{ outlineColor: COR_REVISAR }}
                  />{" "}
                  Revisar
                </span>
                <span>
                  <i
                    className={css.simCliente}
                    style={{ background: COR_CLIENTE }}
                  />{" "}
                  Cliente
                </span>
                <span>
                  <i className={css.simParecido} /> Parecido
                </span>
                <span>
                  <i className={css.simTarefa} /> Tem tarefa aberta
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Zoom ── */}
      <div
        className={`${css.zoom} ${noSelecionado ? css.zoomComPainel : ""}`}
        role="group"
        aria-label="Zoom"
      >
        <button
          type="button"
          className={css.botaoZoom}
          title="Aproximar"
          aria-label="Aproximar"
          onClick={() =>
            grafo.current?.zoom((grafo.current.zoom() ?? 1) * 1.4, 250)
          }
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={css.botaoZoom}
          title="Afastar"
          aria-label="Afastar"
          onClick={() =>
            grafo.current?.zoom((grafo.current.zoom() ?? 1) / 1.4, 250)
          }
        >
          <Minus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={css.botaoZoom}
          title="Enquadrar tudo (F)"
          aria-label="Enquadrar tudo"
          onClick={enquadrar}
        >
          <Maximize2 size={15} aria-hidden="true" />
        </button>
      </div>

      {/* ── Estados ── */}
      {consulta.isPending && (
        <div className={css.centro} aria-live="polite">
          <div className={css.carregando} />
          <p className={css.resumo}>Montando o mapa…</p>
        </div>
      )}
      {d && totalRegistros === 0 && (
        <div className={css.centro}>
          <p className={css.vazioTitulo}>
            O mapa aparece quando houver registros.
          </p>
          <Link to="/registros/novo" className="botao botao-primario">
            Escrever o primeiro POP
          </Link>
        </div>
      )}
      {d && totalRegistros > 0 && visiveis.nodes.length === 0 && (
        <div className={css.centro}>
          <p className={css.vazioTitulo}>Nada com esses filtros.</p>
          <button
            type="button"
            className="botao"
            onClick={() => {
              setTipos(new Set());
              setAreasOcultas(new Set());
              setVerRascunhos(true);
            }}
          >
            Limpar filtros
          </button>
        </div>
      )}

      {noSelecionado && (
        <Painel
          no={noSelecionado}
          vizinhos={[...(vizinhos.get(noSelecionado.id) ?? [])]
            .map((id) => cacheNos.current.get(id)!)
            .filter(Boolean)}
          ligacoes={visiveis.links}
          aoFechar={() => setSelecionado(null)}
          aoIr={(id) => irPara(id)}
        />
      )}
    </div>
  );
}

function Pilula({
  ativa,
  opcao = false,
  onClick,
  children,
}: {
  ativa: boolean;
  /** Liga/desliga uma camada (não é filtro de tipo): destaque mais leve. */
  opcao?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`${css.pilula} ${ativa ? (opcao ? css.pilulaOpcao : css.pilulaAtiva) : ""}`}
      aria-pressed={ativa}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Painel({
  no,
  vizinhos,
  ligacoes,
  aoFechar,
  aoIr,
}: {
  no: No;
  vizinhos: No[];
  ligacoes: Ligacao[];
  aoFechar: () => void;
  aoIr: (id: string) => void;
}) {
  // Como cada vizinho se liga a este nó (a relação mais forte vence).
  const prioridade = [
    "substitui",
    "contradiz",
    "implementa",
    "referencia",
    "cliente",
    "semelhante",
    "area",
  ];
  const tipoCom = new Map<string, string>();
  for (const l of ligacoes) {
    const a = idDe(l.origem);
    const b = idDe(l.destino);
    const outro = a === no.id ? b : b === no.id ? a : null;
    if (!outro) continue;
    const atual = tipoCom.get(outro);
    if (!atual || prioridade.indexOf(l.tipo) < prioridade.indexOf(atual))
      tipoCom.set(outro, l.tipo);
  }
  const lista = vizinhos
    .filter((v) => no.categoria !== "registro" || v.categoria !== "area")
    .sort(
      (a, b) =>
        prioridade.indexOf(tipoCom.get(a.id) ?? "area") -
          prioridade.indexOf(tipoCom.get(b.id) ?? "area") || b.grau - a.grau,
    );
  const cor = corDoNo(no);
  const meta =
    no.categoria === "registro"
      ? `${no.codigo}`
      : no.categoria === "area"
        ? "Área"
        : "Cliente";
  const perguntar = () =>
    window.dispatchEvent(
      new CustomEvent("argos:perguntar", {
        detail:
          no.categoria === "registro"
            ? `Me explica o ${no.codigo}, ${no.rotulo}, e o que ele tem a ver com a operação hoje.`
            : no.categoria === "cliente"
              ? `Como está o cliente ${no.rotulo}? Entregas, SLA e o que temos registrado sobre ele.`
              : `Resume o que temos registrado sobre a área ${no.rotulo}.`,
      }),
    );

  return (
    <aside className={css.painel} aria-label={`Detalhes de ${no.rotulo}`}>
      <div className={css.painelTopo}>
        <span className={css.painelCodigo} style={{ color: cor }}>
          {meta}
        </span>
        <button
          type="button"
          className={css.fechar}
          onClick={aoFechar}
          aria-label="Fechar"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <h2 className={css.painelTitulo}>{no.rotulo}</h2>
      <div className={css.etiquetas}>
        {no.categoria === "registro" && (
          <>
            <span
              className={css.etiqueta}
              style={{
                color: cor,
                borderColor: `${cor}55`,
                background: `${cor}1f`,
              }}
            >
              {nomeTipo(no.tipo!)}
            </span>
            <span className={css.etiqueta}>{NOME_STATUS[no.status!]}</span>
            <span className={css.etiqueta}>{NOME_AREA[no.area!]}</span>
            {no.restrito && <span className={css.etiqueta}>Restrito</span>}
          </>
        )}
        {no.categoria !== "registro" && (
          <span className={css.etiqueta}>{lista.length} registros ligados</span>
        )}
      </div>

      <div className={css.metricas}>
        <div className={css.metrica}>
          <span>ligações</span>
          <b>{lista.length}</b>
        </div>
        <div className={css.metrica}>
          <span>tarefas abertas</span>
          <b style={{ color: no.tarefasAbertas ? "#B45309" : undefined }}>{no.tarefasAbertas}</b>
        </div>
        <div className={css.metrica}>
          <span>atualizado</span>
          <b className={css.metricaTexto}>
            {no.atualizadoEm ? relativo(no.atualizadoEm) : "—"}
          </b>
        </div>
      </div>

      {lista.length > 0 && (
        <>
          <h3 className={css.painelSecao}>
            {no.categoria === "registro" ? "Ligado a" : "Registros"}
          </h3>
          <ul className={css.conexoes}>
            {lista.slice(0, 40).map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={css.conexao}
                  onClick={() => aoIr(v.id)}
                >
                  <span
                    className={css.bolinha}
                    style={{ background: corDoNo(v) }}
                    aria-hidden="true"
                  />
                  <span className={css.conexaoTexto}>
                    {v.codigo ? `${v.codigo} · ` : ""}
                    {v.rotulo}
                  </span>
                  {no.categoria === "registro" && (
                    <span className={css.conexaoTipo}>
                      {NOME_LIGACAO[tipoCom.get(v.id) ?? "area"]}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className={css.acoesPainel}>
        {no.categoria === "registro" && (
          <Link
            to={`/registros/${no.codigo}`}
            className={`botao botao-primario ${css.abrir}`}
          >
            Abrir registro <ArrowRight size={15} aria-hidden="true" />
          </Link>
        )}
        {no.categoria === "cliente" && (
          <Link
            to={`/biblioteca?texto=${encodeURIComponent(no.rotulo)}`}
            className={`botao botao-primario ${css.abrir}`}
          >
            Ver na biblioteca
          </Link>
        )}
        <button type="button" className={css.perguntar} onClick={perguntar}>
          <MessageCircle size={15} aria-hidden="true" /> Perguntar ao Argos
        </button>
      </div>
    </aside>
  );
}
