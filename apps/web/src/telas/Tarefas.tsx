import type { DetalheTarefaDTO, TarefaDTO } from "@cerebro/core/publico";
import { CalendarDays, CalendarPlus, Columns3, ExternalLink, Link2, List, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { useRegistros, useUsuarios } from "../api/consultas";
import {
  useAtualizarTarefa,
  useCriarTarefa,
  useExcluirTarefa,
  useLembreteTarefa,
  useLigarRegistro,
  useMoverTarefa,
  useReuniaoTarefa,
  useReunioesParaLigar,
  useTarefa,
  useTarefas,
  type FiltroTarefa,
  type StatusTarefa,
} from "../api/tarefas";
import { Esqueleto, MensagemErro, Vazio, textoDoErro, useAtalho, useAvisar } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { iniciais, relativo } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Tarefas.module.css";

const FUSO = "America/Bahia";
const COLUNAS: { status: StatusTarefa; titulo: string }[] = [
  { status: "a_fazer", titulo: "A fazer" },
  { status: "fazendo", titulo: "Fazendo" },
  { status: "feita", titulo: "Feita" },
];
const NOME_STATUS: Record<StatusTarefa, string> = { a_fazer: "A fazer", fazendo: "Fazendo", feita: "Feita" };
const NOME_ORIGEM: Record<TarefaDTO["origem"], string> = { manual: "criada à mão", ata: "veio de uma ata", argos: "criada pelo Argos", claude: "criada pelo Claude", email: "veio de um e-mail" };

// ───────────────────────────── Datas ─────────────────────────────

const hojeIso = () => new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
function somarDias(iso: string, dias: number) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function rotuloPrazo(prazo: string | null) {
  if (!prazo) return "";
  const hoje = hojeIso();
  if (prazo === hoje) return "Hoje";
  if (prazo === somarDias(hoje, 1)) return "Amanhã";
  if (prazo === somarDias(hoje, -1)) return "Ontem";
  const d = new Date(`${prazo}T12:00:00Z`);
  const semana = d.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "");
  return `${semana.charAt(0).toUpperCase()}${semana.slice(1)} ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" })}`;
}
const quandoEvento = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: FUSO }) : "";

const DIAS_SEMANA = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "ligar pra Rede Beta sexta @Leonardo" → título, prazo e responsável. */
export function lerAdicaoRapida(texto: string) {
  let resto = ` ${texto.trim()} `;
  let responsavel: string | null = null;
  let prazo: string | null = null;
  const arroba = /\s@([\p{L}][\p{L}.]*(?:\s(?!(?:hoje|amanha|amanhã|segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo|dia)\b)[\p{L}][\p{L}.]*){0,2})/u.exec(resto);
  if (arroba) {
    responsavel = arroba[1]!.trim();
    resto = resto.replace(arroba[0], " ");
  }
  const hoje = hojeIso();
  const data = /\s(?:dia\s)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/.exec(resto);
  if (data) {
    const ano = data[3] ? (data[3].length === 2 ? `20${data[3]}` : data[3]) : hoje.slice(0, 4);
    prazo = `${ano}-${data[2]!.padStart(2, "0")}-${data[1]!.padStart(2, "0")}`;
    if (!data[3] && prazo < hoje) prazo = `${Number(ano) + 1}${prazo.slice(4)}`;
    resto = resto.replace(data[0], " ");
  } else {
    const palavra = /\s(hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(?:-feira)?(?=\s)/i.exec(resto);
    if (palavra) {
      const p = semAcento(palavra[1]!);
      if (p === "hoje") prazo = hoje;
      else if (p.startsWith("amanh")) prazo = somarDias(hoje, 1);
      else {
        const alvo = DIAS_SEMANA.indexOf(p);
        const atual = new Date(`${hoje}T12:00:00Z`).getUTCDay();
        prazo = somarDias(hoje, ((alvo - atual + 7) % 7) || 7);
      }
      resto = resto.replace(palavra[0], " ");
    }
  }
  return { titulo: resto.replace(/\s+/g, " ").trim(), responsavel, prazo };
}

function lerPreferencia<T extends string>(chave: string, padrao: T, validos: readonly T[]): T {
  try {
    const v = localStorage.getItem(chave) as T | null;
    return v && validos.includes(v) ? v : padrao;
  } catch {
    return padrao;
  }
}
function salvarPreferencia(chave: string, valor: string) {
  try {
    localStorage.setItem(chave, valor);
  } catch {
    /* sem armazenamento: vale só nesta visita */
  }
}

// ───────────────────────────── Pedaços ─────────────────────────────

function Avatar({ t }: { t: TarefaDTO }) {
  if (!t.responsavel) return <span className={`${css.avatar} ${css.avatarVazio}`} aria-label="Sem responsável" title="Sem responsável" />;
  return (
    <span className={css.avatar} title={t.responsavel.nome} aria-label={`Responsável: ${t.responsavel.nome}`}>
      {iniciais(t.responsavel.nome)}
    </span>
  );
}

function Origem({ t }: { t: TarefaDTO }) {
  const r = t.registros[0];
  if (r) return <span className={`${css.chip} ${css[`chip_${r.tipo}`] ?? ""}`}>{r.tipo === "reuniao" ? `Ata · ${r.titulo}` : `${r.codigo} · ${r.titulo}`}</span>;
  if (t.clienteRef) return <span className={`${css.chip} ${css.chip_cliente}`}>Cliente · {t.clienteRef}</span>;
  if (t.origem === "argos") return <span className={`${css.chip} ${css.chipArgos}`}>Argos</span>;
  if (t.origem === "claude") return <span className={`${css.chip} ${css.chipArgos}`}>Claude</span>;
  return null;
}

function Prazo({ t }: { t: TarefaDTO }) {
  if (!t.prazo) return <span className={css.prazo} />;
  return <span className={`${css.prazo} ${t.atrasada ? css.prazoAtrasado : ""}`}>{rotuloPrazo(t.prazo)}</span>;
}

function IconeAgenda({ t }: { t: TarefaDTO }) {
  if (!t.evento) return null;
  return (
    <span title={`Na agenda: ${t.evento.titulo}`} className={css.iconeAgenda}>
      <CalendarDays size={15} aria-label="Na agenda" />
    </span>
  );
}

// ───────────────────────────── Lista ─────────────────────────────

function Linha({ t, ativa, aoAbrir }: { t: TarefaDTO; ativa: boolean; aoAbrir: () => void }) {
  const atualizar = useAtualizarTarefa();
  const avisar = useAvisar();
  const feita = t.status === "feita";
  return (
    <li className={`${css.linha} ${ativa ? css.linhaAtiva : ""} ${feita ? css.linhaFeita : ""}`}>
      <input
        type="checkbox"
        className={css.marcar}
        checked={feita}
        aria-label={feita ? `Reabrir: ${t.titulo}` : `Concluir: ${t.titulo}`}
        onChange={() =>
          atualizar.mutate(
            { id: t.id, status: feita ? "a_fazer" : "feita" },
            { onSuccess: (n) => !feita && avisar(`${n.codigo} concluída.`), onError: (e) => avisar(textoDoErro(e), "erro") },
          )
        }
      />
      <button type="button" className={css.linhaBotao} onClick={aoAbrir}>
        <span className={css.linhaTitulo}>{t.titulo}</span>
        <span className={css.linhaMeta}>
          <Origem t={t} />
          <IconeAgenda t={t} />
          <Prazo t={t} />
          <Avatar t={t} />
        </span>
      </button>
    </li>
  );
}

function grupos(lista: TarefaDTO[]) {
  const hoje = hojeIso();
  const fimSemana = somarDias(hoje, 6);
  const g: { chave: string; titulo: string; itens: TarefaDTO[]; alerta?: boolean }[] = [
    { chave: "atrasadas", titulo: "Atrasadas", itens: [], alerta: true },
    { chave: "hoje", titulo: "Hoje", itens: [] },
    { chave: "semana", titulo: "Esta semana", itens: [] },
    { chave: "depois", titulo: "Depois", itens: [] },
    { chave: "sem", titulo: "Sem prazo", itens: [] },
    { chave: "feitas", titulo: "Feitas recentemente", itens: [] },
  ];
  const por = Object.fromEntries(g.map((x) => [x.chave, x]));
  for (const t of lista) {
    if (t.status === "feita") por.feitas!.itens.push(t);
    else if (!t.prazo) por.sem!.itens.push(t);
    else if (t.prazo < hoje) por.atrasadas!.itens.push(t);
    else if (t.prazo === hoje) por.hoje!.itens.push(t);
    else if (t.prazo <= fimSemana) por.semana!.itens.push(t);
    else por.depois!.itens.push(t);
  }
  for (const x of g) if (x.chave !== "sem" && x.chave !== "feitas") x.itens.sort((a, b) => (a.prazo ?? "").localeCompare(b.prazo ?? ""));
  return g.filter((x) => x.itens.length);
}

function VistaLista({ lista, aberta, abrir }: { lista: TarefaDTO[]; aberta: string | null; abrir: (t: TarefaDTO) => void }) {
  return (
    <div className={css.grupos}>
      {grupos(lista).map((g) => (
        <section key={g.chave} className={css.grupo} aria-labelledby={`g-${g.chave}`}>
          <h2 id={`g-${g.chave}`} className={`${css.grupoTitulo} ${g.alerta ? css.grupoAlerta : ""}`}>
            {g.titulo} · {g.itens.length}
          </h2>
          <ul className={css.cartaoLista}>
            {g.itens.map((t) => (
              <Linha key={t.id} t={t} ativa={aberta === t.id || aberta === t.codigo} aoAbrir={() => abrir(t)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────────── Quadro (kanban) ─────────────────────────────

function VistaQuadro({ lista, aberta, abrir }: { lista: TarefaDTO[]; aberta: string | null; abrir: (t: TarefaDTO) => void }) {
  const mover = useMoverTarefa();
  const avisar = useAvisar();
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<{ status: StatusTarefa; antesDe: string | null } | null>(null);

  const porColuna = useMemo(() => {
    const m: Record<StatusTarefa, TarefaDTO[]> = { a_fazer: [], fazendo: [], feita: [] };
    for (const t of lista) m[t.status].push(t);
    return m;
  }, [lista]);

  const soltar = (e: DragEvent, status: StatusTarefa) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain") || arrastando;
    setArrastando(null);
    const destino = alvo?.status === status ? alvo : { status, antesDe: null };
    setAlvo(null);
    if (!id) return;
    const atual = lista.find((t) => t.id === id);
    if (atual && atual.status === status && destino.antesDe === id) return;
    mover.mutate({ id, ...destino }, { onError: (erro) => avisar(textoDoErro(erro), "erro") });
  };

  return (
    <div className={css.quadro}>
      {COLUNAS.map((c) => (
        <section
          key={c.status}
          className={`${css.coluna} ${alvo?.status === c.status ? css.colunaAlvo : ""}`}
          aria-labelledby={`col-${c.status}`}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (alvo?.status !== c.status || (e.target as HTMLElement).dataset.coluna) setAlvo({ status: c.status, antesDe: (e.target as HTMLElement).dataset.coluna ? null : (alvo?.antesDe ?? null) });
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setAlvo((a) => (a?.status === c.status ? null : a));
          }}
          onDrop={(e) => soltar(e, c.status)}
        >
          <header className={css.colunaTopo}>
            <h2 id={`col-${c.status}`}>{c.titulo}</h2>
            <span className={css.colunaConta}>{porColuna[c.status].length}</span>
          </header>
          <ul className={css.colunaLista} data-coluna={c.status}>
            {porColuna[c.status].map((t) => (
              <li
                key={t.id}
                draggable
                className={`${css.cartaoQuadro} ${arrastando === t.id ? css.cartaoArrastando : ""} ${alvo?.antesDe === t.id ? css.cartaoAntes : ""} ${aberta === t.id || aberta === t.codigo ? css.cartaoAtivo : ""}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setArrastando(t.id);
                }}
                onDragEnd={() => {
                  setArrastando(null);
                  setAlvo(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const caixa = e.currentTarget.getBoundingClientRect();
                  const lista = porColuna[c.status];
                  const i = lista.findIndex((x) => x.id === t.id);
                  // Metade de baixo do cartão: solta depois dele (antes do próximo).
                  const antesDe = e.clientY > caixa.top + caixa.height / 2 ? (lista[i + 1]?.id ?? null) : t.id;
                  if (alvo?.status !== c.status || alvo.antesDe !== antesDe) setAlvo({ status: c.status, antesDe });
                }}
              >
                <button type="button" className={css.cartaoBotao} onClick={() => abrir(t)}>
                  <span className={`${css.cartaoTitulo} ${t.status === "feita" ? css.riscado : ""}`}>{t.titulo}</span>
                  <Origem t={t} />
                  <span className={css.cartaoRodape}>
                    <span className="mono pequeno suave">{t.codigo}</span>
                    <IconeAgenda t={t} />
                    <Prazo t={t} />
                    <Avatar t={t} />
                  </span>
                </button>
              </li>
            ))}
            {alvo?.status === c.status && alvo.antesDe === null && arrastando && <li className={css.marcadorFim} aria-hidden="true" />}
            {!porColuna[c.status].length && <li className={css.colunaVazia}>Arraste uma tarefa para cá</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ───────────────────────────── Detalhe ─────────────────────────────

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className={css.secao}>
      <h3 className={css.secaoTitulo}>{titulo}</h3>
      {children}
    </section>
  );
}

function Agenda({ t }: { t: DetalheTarefaDTO }) {
  const avisar = useAvisar();
  const [escolhendo, setEscolhendo] = useState(false);
  const [quando, setQuando] = useState("");
  const reunioes = useReunioesParaLigar(escolhendo);
  const reuniao = useReuniaoTarefa();
  const lembrete = useLembreteTarefa();
  const precisaConectar = (e: unknown) => e instanceof ErroApi && e.status === 503;

  if (t.evento) {
    return (
      <div className={css.agenda}>
        <span className={css.agendaRotulo}>
          <CalendarDays size={14} aria-hidden="true" /> NA AGENDA
        </span>
        <span className={css.agendaTitulo}>{t.evento.titulo}</span>
        <span className="suave pequeno">{quandoEvento(t.evento.inicio)} · a tarefa aparece na pauta da reunião.</span>
        <div className={css.agendaAcoes}>
          {t.evento.url && (
            <a href={t.evento.url} target="_blank" rel="noreferrer noopener" className="botao botao-pequeno">
              <ExternalLink size={13} aria-hidden="true" /> Abrir evento
            </a>
          )}
          <button
            type="button"
            className="botao botao-fantasma botao-pequeno"
            disabled={reuniao.isPending}
            onClick={() => reuniao.mutate({ id: t.id, eventoId: null }, { onError: (e) => avisar(textoDoErro(e), "erro") })}
          >
            Tirar da agenda
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={css.agendaVazia}>
      <div className={css.agendaAcoes}>
        <button type="button" className="botao botao-pequeno" aria-expanded={escolhendo} onClick={() => setEscolhendo((v) => !v)}>
          <CalendarDays size={14} aria-hidden="true" /> Colocar na pauta de uma reunião
        </button>
        <button
          type="button"
          className="botao botao-pequeno"
          disabled={lembrete.isPending}
          onClick={() =>
            lembrete.mutate(
              { id: t.id, quando: quando ? new Date(quando).toISOString() : null },
              { onSuccess: () => avisar("Lembrete criado na agenda."), onError: (e) => avisar(textoDoErro(e), "erro") },
            )
          }
        >
          <CalendarPlus size={14} aria-hidden="true" /> {lembrete.isPending ? "Criando…" : "Criar lembrete"}
        </button>
      </div>
      <label className={css.campoPequeno}>
        <span>Lembrete em (vazio = no prazo, o dia todo)</span>
        <input type="datetime-local" className="entrada" value={quando} onChange={(e) => setQuando(e.target.value)} />
      </label>
      {escolhendo && (
        <div className={css.reunioes}>
          {reunioes.isPending && <Esqueleto linhas={2} />}
          {reunioes.isError &&
            (precisaConectar(reunioes.error) ? (
              <p className="pequeno">
                {textoDoErro(reunioes.error)} <Link to="/integracoes">Ir para Integrações</Link>
              </p>
            ) : (
              <MensagemErro erro={reunioes.error} aoTentar={() => void reunioes.refetch()} />
            ))}
          {reunioes.data?.length === 0 && <p className="suave pequeno">Nenhuma reunião nas próximas 3 semanas.</p>}
          {reunioes.data?.map((ev) => (
            <button
              key={ev.id}
              type="button"
              className={css.reuniao}
              disabled={reuniao.isPending}
              onClick={() =>
                reuniao.mutate(
                  { id: t.id, eventoId: ev.id },
                  {
                    onSuccess: () => {
                      setEscolhendo(false);
                      avisar(`Na pauta de "${ev.titulo}".`);
                    },
                    onError: (e) => avisar(textoDoErro(e), "erro"),
                  },
                )
              }
            >
              <span>{ev.titulo}</span>
              <span className="suave pequeno">{quandoEvento(ev.inicio)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LigarRegistro({ t }: { t: DetalheTarefaDTO }) {
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const busca = useRegistros({ texto: texto.trim() || undefined, porPagina: 6 });
  const ligar = useLigarRegistro();
  const avisar = useAvisar();
  const ja = new Set(t.registros.map((r) => r.id));

  if (!aberto) {
    return (
      <button type="button" className={css.adicionarLigacao} onClick={() => setAberto(true)}>
        <Link2 size={14} aria-hidden="true" /> Ligar a um registro ou cliente
      </button>
    );
  }
  return (
    <div className={css.ligar}>
      <label className="so-leitor" htmlFor="busca-ligar">
        Buscar registro
      </label>
      <input
        id="busca-ligar"
        className="entrada"
        placeholder="POP, regra, cliente, documento…"
        value={texto}
        autoFocus
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setAberto(false)}
      />
      <ul className={css.ligarLista}>
        {busca.data?.itens
          .filter((r) => !ja.has(r.id))
          .map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className={css.ligarItem}
                onClick={() =>
                  ligar.mutate(
                    { id: t.id, registroId: r.id, ligar: true },
                    {
                      onSuccess: () => {
                        setAberto(false);
                        setTexto("");
                      },
                      onError: (e) => avisar(textoDoErro(e), "erro"),
                    },
                  )
                }
              >
                <span className="mono pequeno">{r.codigo}</span> {r.titulo}
              </button>
            </li>
          ))}
      </ul>
      <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => setAberto(false)}>
        Cancelar
      </button>
    </div>
  );
}

function Detalhe({ id, aoFechar }: { id: string; aoFechar: () => void }) {
  const consulta = useTarefa(id);
  const usuarios = useUsuarios();
  const atualizar = useAtualizarTarefa();
  const excluir = useExcluirTarefa();
  const ligar = useLigarRegistro();
  const avisar = useAvisar();
  const eu = useUsuario();
  const [confirmando, setConfirmando] = useState(false);
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [outro, setOutro] = useState(false);
  const t = consulta.data;

  useEffect(() => {
    if (t) {
      setTitulo(t.titulo);
      setDescricao(t.descricao);
      setOutro(!!t.responsavel && !t.responsavel.id);
      setConfirmando(false);
    }
  }, [t?.id, t?.atualizadoEm]); // eslint-disable-line react-hooks/exhaustive-deps

  const salvar = useCallback(
    (m: Parameters<typeof atualizar.mutate>[0]) => atualizar.mutate(m, { onError: (e) => avisar(textoDoErro(e), "erro") }),
    [atualizar, avisar],
  );

  return (
    <aside className={css.painel} aria-label="Detalhe da tarefa">
      {consulta.isError ? (
        <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />
      ) : !t ? (
        <Esqueleto linhas={8} />
      ) : (
        <>
          <div className={css.painelTopo}>
            <span className="mono pequeno">{t.codigo}</span>
            <span className="suave pequeno">· {NOME_ORIGEM[t.origem]}</span>
            <button type="button" className={`botao botao-fantasma botao-icone ${css.fechar}`} onClick={aoFechar} aria-label="Fechar">
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <label className="so-leitor" htmlFor="titulo-tarefa">
            Título
          </label>
          <textarea
            id="titulo-tarefa"
            className={css.tituloEditavel}
            value={titulo}
            rows={2}
            onChange={(e) => setTitulo(e.target.value)}
            onBlur={() => titulo.trim().length >= 2 && titulo.trim() !== t.titulo && salvar({ id: t.id, titulo: titulo.trim() })}
          />

          <div className={css.campos}>
            <label className={css.campoPequeno}>
              <span>Situação</span>
              <select className="selecao" value={t.status} onChange={(e) => salvar({ id: t.id, status: e.target.value as StatusTarefa })}>
                {COLUNAS.map((c) => (
                  <option key={c.status} value={c.status}>
                    {c.titulo}
                  </option>
                ))}
              </select>
            </label>
            <label className={css.campoPequeno}>
              <span>Prazo</span>
              <input type="date" className="entrada" value={t.prazo ?? ""} onChange={(e) => salvar({ id: t.id, prazo: e.target.value || null })} />
            </label>
            <label className={`${css.campoPequeno} ${css.campoInteiro}`}>
              <span>Responsável</span>
              <select
                className="selecao"
                value={outro ? "__outro" : (t.responsavel?.id ?? "")}
                onChange={(e) => {
                  if (e.target.value === "__outro") return setOutro(true);
                  setOutro(false);
                  salvar({ id: t.id, responsavelId: e.target.value || null });
                }}
              >
                <option value="">Ninguém</option>
                {usuarios.data
                  ?.filter((u) => u.ativo)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nome}
                      {u.id === eu.id ? " (você)" : ""}
                    </option>
                  ))}
                <option value="__outro">Outro (time ou pessoa de fora)…</option>
              </select>
            </label>
            {outro && (
              <label className={`${css.campoPequeno} ${css.campoInteiro}`}>
                <span>Nome do time ou da pessoa</span>
                <input
                  className="entrada"
                  defaultValue={t.responsavel && !t.responsavel.id ? t.responsavel.nome : ""}
                  placeholder="ex.: Supervisão SSA"
                  onBlur={(e) => e.target.value.trim() && salvar({ id: t.id, responsavelTexto: e.target.value.trim() })}
                />
              </label>
            )}
          </div>

          <label className={css.campoPequeno}>
            <span>Detalhes</span>
            <textarea
              className="area-texto"
              rows={3}
              value={descricao}
              placeholder="O que precisa ser feito, contexto, links…"
              onChange={(e) => setDescricao(e.target.value)}
              onBlur={() => descricao !== t.descricao && salvar({ id: t.id, descricao })}
            />
          </label>

          <Secao titulo="Agenda">
            <Agenda t={t} />
          </Secao>

          <Secao titulo="Ligada a">
            {t.registros.length > 0 && (
              <ul className={css.ligacoes}>
                {t.registros.map((r) => (
                  <li key={r.id} className={css.ligacao}>
                    <Link to={`/registros/${r.codigo}`} className={css.ligacaoLink}>
                      <span className={`${css.bolinha} ${css[`bolinha_${r.tipo}`] ?? ""}`} aria-hidden="true" />
                      {r.tipo === "reuniao" ? `Ata · ${r.titulo}` : `${r.codigo} · ${r.titulo}`}
                    </Link>
                    {r.origem ? (
                      <span className="suave pequeno">origem</span>
                    ) : (
                      <button
                        type="button"
                        className="botao botao-fantasma botao-icone"
                        aria-label={`Desligar ${r.codigo}`}
                        onClick={() => ligar.mutate({ id: t.id, registroId: r.id, ligar: false })}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {t.clienteRef && <p className="pequeno">Cliente: {t.clienteRef}</p>}
            <LigarRegistro t={t} />
          </Secao>

          <Secao titulo="Histórico">
            <ul className={css.historico}>
              {t.historico.map((h, i) => (
                <li key={i}>
                  <b>{h.quem ?? "Alguém"}</b> {h.acao} · <span className="suave">{relativo(h.quando)}</span>
                </li>
              ))}
            </ul>
          </Secao>

          <div className={css.excluir}>
            {confirmando ? (
              <>
                <span className="pequeno">Excluir {t.codigo} de vez?</span>
                <button
                  type="button"
                  className="botao botao-pequeno botao-perigo"
                  disabled={excluir.isPending}
                  onClick={() =>
                    excluir.mutate(t.id, {
                      onSuccess: () => {
                        avisar(`${t.codigo} excluída.`);
                        aoFechar();
                      },
                      onError: (e) => avisar(textoDoErro(e), "erro"),
                    })
                  }
                >
                  Excluir {t.codigo}
                </button>
                <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => setConfirmando(false)}>
                  Manter
                </button>
              </>
            ) : (
              <button type="button" className="botao botao-fantasma botao-pequeno botao-perigo" onClick={() => setConfirmando(true)}>
                <Trash2 size={14} aria-hidden="true" /> Excluir tarefa
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

// ───────────────────────────── Tela ─────────────────────────────

function AdicaoRapida() {
  const [texto, setTexto] = useState("");
  const criar = useCriarTarefa();
  const avisar = useAvisar();
  const campo = useRef<HTMLInputElement>(null);
  const lido = lerAdicaoRapida(texto);
  useAtalho("n", useCallback(() => campo.current?.focus(), []));

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (lido.titulo.length < 2) return;
    criar.mutate(
      { titulo: lido.titulo, prazo: lido.prazo, responsavelTexto: lido.responsavel },
      {
        onSuccess: (t) => {
          setTexto("");
          avisar(`${t.codigo} criada.`);
        },
        onError: (erro) => avisar(textoDoErro(erro), "erro"),
      },
    );
  }

  return (
    <form className={css.rapida} onSubmit={enviar}>
      <Plus size={16} aria-hidden="true" className={css.rapidaIcone} />
      <label htmlFor="nova-tarefa" className="so-leitor">
        Adicionar tarefa
      </label>
      <input
        ref={campo}
        id="nova-tarefa"
        className={css.rapidaEntrada}
        placeholder="Adicionar tarefa… ex.: ligar para a Rede Beta sexta @Leonardo"
        value={texto}
        autoComplete="off"
        onChange={(e) => setTexto(e.target.value)}
      />
      {(lido.prazo || lido.responsavel) && texto && (
        <span className={css.rapidaLido} aria-live="polite">
          {lido.prazo && <span>{rotuloPrazo(lido.prazo)}</span>}
          {lido.responsavel && <span>@{lido.responsavel}</span>}
        </span>
      )}
      <button type="submit" className="botao botao-primario botao-pequeno" disabled={lido.titulo.length < 2 || criar.isPending}>
        Adicionar
      </button>
    </form>
  );
}

const FILTROS: { valor: FiltroTarefa; rotulo: string }[] = [
  { valor: "minhas", rotulo: "Minhas" },
  { valor: "todas", rotulo: "Todas" },
  { valor: "atrasadas", rotulo: "Atrasadas" },
  { valor: "feitas", rotulo: "Feitas" },
];

export default function Tarefas() {
  const [params, setParams] = useSearchParams();
  const [filtro, setFiltroEstado] = useState<FiltroTarefa>(() => lerPreferencia("cerebro.tarefas.filtro", "todas", ["minhas", "todas", "atrasadas", "feitas"]));
  const [vista, setVistaEstado] = useState<"lista" | "quadro">(() => lerPreferencia("cerebro.tarefas.vista", "lista", ["lista", "quadro"]));
  const [texto, setTexto] = useState("");
  const consulta = useTarefas(filtro, texto.trim());
  const todas = useTarefas("todas");
  const minhas = useTarefas("minhas");
  const atrasadas = useTarefas("atrasadas");
  const aberta = params.get("abrir");
  const campoBusca = useRef<HTMLInputElement>(null);
  useAtalho("/", useCallback(() => campoBusca.current?.focus(), []));

  const setFiltro = (f: FiltroTarefa) => {
    setFiltroEstado(f);
    salvarPreferencia("cerebro.tarefas.filtro", f);
  };
  const setVista = (v: "lista" | "quadro") => {
    setVistaEstado(v);
    salvarPreferencia("cerebro.tarefas.vista", v);
  };
  const abrir = (t: TarefaDTO) => setParams({ abrir: t.codigo }, { replace: true });
  const fechar = useCallback(() => setParams({}, { replace: true }), [setParams]);
  useAtalho("Escape", fechar);

  const contagem: Partial<Record<FiltroTarefa, number>> = {
    todas: todas.data?.filter((t) => t.status !== "feita").length,
    minhas: minhas.data?.filter((t) => t.status !== "feita").length,
    atrasadas: atrasadas.data?.length,
  };
  // No quadro, "Feitas" é uma coluna: o filtro de feitas vira "todas".
  const lista = consulta.data ?? [];

  return (
    <div className={`${css.tela} ${aberta ? css.comPainel : ""}`}>
      <div className={css.principal}>
        <header className={pg.cabecalho}>
          <div className={pg.titulos}>
            <h1>Tarefas</h1>
            <p className="suave">O que ficou combinado nas reuniões, nos registros e com o Argos.</p>
          </div>
          <button type="button" className="botao botao-primario" onClick={() => document.getElementById("nova-tarefa")?.focus()}>
            <Plus size={16} aria-hidden="true" /> Nova tarefa
          </button>
        </header>

        <div className={css.barra}>
          <div className={css.segmentos} role="group" aria-label="Filtrar tarefas">
            {FILTROS.map((f) => (
              <button
                key={f.valor}
                type="button"
                aria-pressed={filtro === f.valor}
                className={`${css.segmento} ${filtro === f.valor ? css.segmentoAtivo : ""} ${f.valor === "atrasadas" && contagem.atrasadas ? css.segmentoAlerta : ""}`}
                onClick={() => setFiltro(f.valor)}
              >
                {f.rotulo}
                {contagem[f.valor] !== undefined && <span className={css.segmentoConta}> · {contagem[f.valor]}</span>}
              </button>
            ))}
          </div>
          <label className={css.busca}>
            <Search size={14} aria-hidden="true" />
            <span className="so-leitor">Buscar tarefa</span>
            <input ref={campoBusca} placeholder="Buscar tarefa, pessoa ou cliente" value={texto} onChange={(e) => setTexto(e.target.value)} />
          </label>
          <div className={css.vistas} role="group" aria-label="Visualização">
            <button type="button" aria-pressed={vista === "lista"} className={`${css.vista} ${vista === "lista" ? css.vistaAtiva : ""}`} onClick={() => setVista("lista")}>
              <List size={15} aria-hidden="true" /> Lista
            </button>
            <button type="button" aria-pressed={vista === "quadro"} className={`${css.vista} ${vista === "quadro" ? css.vistaAtiva : ""}`} onClick={() => setVista("quadro")}>
              <Columns3 size={15} aria-hidden="true" /> Quadro
            </button>
          </div>
        </div>

        <AdicaoRapida />

        {consulta.isError ? (
          <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />
        ) : consulta.isPending ? (
          <Esqueleto linhas={6} altura={44} />
        ) : !lista.length && vista === "lista" ? (
          <Vazio
            titulo={texto ? "Nenhuma tarefa com essa busca." : filtro === "minhas" ? "Nada com você agora." : filtro === "atrasadas" ? "Nenhuma tarefa atrasada." : "Nenhuma tarefa por aqui."}
            texto={
              texto || filtro !== "todas"
                ? undefined
                : "As pendências das atas aprovadas viram tarefas sozinhas. Você também pode escrever acima ou pedir ao Argos."
            }
          />
        ) : vista === "lista" ? (
          <VistaLista lista={lista} aberta={aberta} abrir={abrir} />
        ) : (
          <VistaQuadro lista={lista} aberta={aberta} abrir={abrir} />
        )}
      </div>

      {aberta && <Detalhe id={aberta} aoFechar={fechar} />}
    </div>
  );
}

