import type { ItemAgendaDTO } from "@cerebro/core/publico";
import { AlertTriangle, ArrowRight, CalendarDays, Mic, Search, Video } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAgenda } from "../api/agenda";
import { useInicio, useRegistros } from "../api/consultas";
import { useAtualizarTarefa, useTarefas } from "../api/tarefas";
import { Esqueleto, MensagemErro, useAtalho } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { dataLonga, diasAte, hora, saudacao } from "../util/formato";
import css from "./Inicio.module.css";

const hojeBahia = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bahia" });

function rotuloPrazo(prazo: string | null, atrasada: boolean) {
  if (!prazo) return "Sem prazo";
  const d = diasAte(prazo);
  const dia = d === 0 ? "Hoje" : d === 1 ? "Amanhã" : d === -1 ? "Ontem" : new Date(`${prazo}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
  return atrasada ? `Atrasada · ${dia.toLowerCase()}` : dia;
}

/** "Hoje", "Amanhã" ou "qua, 28/10" — no horário da Bahia. */
function diaDaReuniao(iso: string) {
  const dia = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Bahia" });
  const d = diasAte(dia);
  if (d === 0) return "Hoje";
  if (d === 1) return "Amanhã";
  return new Date(iso)
    .toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "America/Bahia" })
    .replace(".", "");
}

function emQuanto(iso: string) {
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (min <= 0) return "agora";
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `em ${h} h`;
  return new Date(iso).toLocaleDateString("pt-BR", { weekday: "short" });
}

/** Próxima reunião (ou a que está acontecendo agora). */
function ProximaReuniao({ itens, carregando, google }: { itens: ItemAgendaDTO[]; carregando: boolean; google: string | undefined }) {
  const agora = Date.now();
  const proxima = itens.find(
    (i) => i.tipo === "evento" && !i.diaInteiro && new Date(i.fim ?? i.inicio).getTime() > agora - 5 * 60_000,
  );
  return (
    <section className={`cartao ${css.cartao}`} aria-labelledby="t-reuniao">
      <div className={css.cabecalho}>
        <h2 id="t-reuniao">Próxima reunião</h2>
        <Link to="/agenda" className="pequeno">
          Agenda
        </Link>
      </div>
      {carregando ? (
        <Esqueleto linhas={2} />
      ) : proxima ? (
        <div className={css.reuniao}>
          <div className={css.hora}>
            <span className={css.diaReuniao}>{diaDaReuniao(proxima.inicio)}</span>
            <strong>{hora(proxima.inicio)}</strong>
            <span>{emQuanto(proxima.inicio)}</span>
          </div>
          <div className={css.reuniaoTexto}>
            <span className={css.reuniaoTitulo}>{proxima.titulo}</span>
            <span className="suave pequeno">
              {proxima.chamada ? "Google Meet" : "Presencial ou sem link"}
              {proxima.tarefas.length ? ` · ${proxima.tarefas.length} ${proxima.tarefas.length === 1 ? "tarefa" : "tarefas"} na pauta` : ""}
            </span>
          </div>
          {proxima.chamada && (
            <a href={proxima.chamada} target="_blank" rel="noreferrer" className="botao botao-primario botao-pequeno">
              <Video size={14} aria-hidden="true" /> Entrar
            </a>
          )}
        </div>
      ) : google === "desligada" ? (
        <p className="suave">
          Conecte o Google Agenda em <Link to="/integracoes">Integrações</Link> para ver suas reuniões aqui.
        </p>
      ) : (
        <p className="suave">Nenhuma reunião marcada para hoje e amanhã.</p>
      )}
    </section>
  );
}

/** As 3 tarefas da pessoa que vencem primeiro (atrasadas no topo). */
function SuasTarefas() {
  const tarefas = useTarefas("minhas");
  const concluir = useAtualizarTarefa();
  const abertas = (tarefas.data ?? [])
    .filter((t) => t.status !== "feita")
    .sort((a, b) => (a.prazo ?? "9999").localeCompare(b.prazo ?? "9999"));
  return (
    <section className={`cartao ${css.cartao}`} aria-labelledby="t-tarefas">
      <div className={css.cabecalho}>
        <h2 id="t-tarefas">Suas tarefas</h2>
        <Link to="/tarefas" className="pequeno">
          {abertas.length > 3 ? `Ver todas (${abertas.length})` : "Ver todas"}
        </Link>
      </div>
      {tarefas.isPending ? (
        <Esqueleto linhas={3} />
      ) : abertas.length ? (
        <ul className={`lista ${css.tarefas}`}>
          {abertas.slice(0, 3).map((t) => (
            <li key={t.id} className={css.tarefa}>
              <input
                type="checkbox"
                className={css.marcar}
                aria-label={`Concluir: ${t.titulo}`}
                onChange={() => concluir.mutate({ id: t.id, status: "feita" })}
              />
              <span className={css.tarefaTexto}>
                <Link to={`/tarefas?abrir=${t.codigo}`} className={css.tarefaTitulo}>
                  {t.titulo}
                </Link>
                <span className="pequeno" style={{ color: t.atrasada ? "var(--erro)" : "var(--texto-suave)" }}>
                  {rotuloPrazo(t.prazo, t.atrasada)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="suave">
          Nada com você agora. <Link to="/tarefas">Abrir as tarefas</Link>
        </p>
      )}
    </section>
  );
}

export function Inicio() {
  const usuario = useUsuario();
  const inicio = useInicio();
  const navegar = useNavigate();
  const hoje = hojeBahia();
  const agenda = useAgenda(hoje, 2);
  const tarefas = useTarefas("minhas");
  const rascunhos = useRegistros({ status: "rascunho", porPagina: 1 });
  const emRevisao = useRegistros({ status: "revisar", porPagina: 1 });
  const [pergunta, setPergunta] = useState("");
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setAgora(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const campo = useRef<HTMLInputElement>(null);
  useAtalho("/", useCallback(() => campo.current?.focus(), []));

  function perguntar(e: FormEvent) {
    e.preventDefault();
    if (pergunta.trim().length >= 2) navegar(`/perguntar?q=${encodeURIComponent(pergunta.trim())}`);
  }

  const abertas = (tarefas.data ?? []).filter((t) => t.status !== "feita");
  const paraHoje = abertas.filter((t) => t.prazo && t.prazo <= hoje).length;
  const atrasadas = abertas.filter((t) => t.atrasada).length;
  const reunioesHoje = (agenda.data?.itens ?? []).filter((i) => i.tipo === "evento" && (i.diaInteiro ? i.inicio.slice(0, 10) : new Date(i.inicio).toLocaleDateString("en-CA", { timeZone: "America/Bahia" })) === hoje).length;
  const paraRevisar = (rascunhos.data?.total ?? 0) + (emRevisao.data?.total ?? 0);
  const vencidos = inicio.data?.vencidos.length ?? 0;

  const numeros = [
    { n: paraHoje, rotulo: paraHoje === 1 ? "Tarefa hoje" : "Tarefas hoje", para: "/tarefas", alerta: atrasadas > 0, carregando: tarefas.isPending },
    { n: reunioesHoje, rotulo: reunioesHoje === 1 ? "Reunião hoje" : "Reuniões hoje", para: "/agenda", carregando: agenda.isPending },
    { n: paraRevisar, rotulo: "Para revisar", para: "/revisar", carregando: rascunhos.isPending },
  ];

  return (
    <div className={css.pagina}>
      <header className={css.titulos}>
        <h1>
          {saudacao()}, {usuario.nome.split(" ")[0]}
        </h1>
        <span className="suave">
          {dataLonga(agora)} · <span className={css.relogio}>{agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" })}</span>
        </span>
      </header>

      <form role="search" onSubmit={perguntar} className={css.busca}>
        <label htmlFor="pergunta" className="so-leitor">
          Pergunte ao Argos
        </label>
        <Search size={18} aria-hidden="true" className={css.lupa} />
        <input
          ref={campo}
          id="pergunta"
          className={css.entradaBusca}
          placeholder="Pergunte ao Argos sobre a operação…"
          value={pergunta}
          onChange={(e) => setPergunta(e.target.value)}
          autoComplete="off"
          enterKeyHint="search"
        />
        {pergunta.trim().length >= 2 ? (
          <button type="submit" className={css.botaoBusca} aria-label="Perguntar">
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        ) : (
          <button type="button" className={css.botaoBusca} onClick={() => window.dispatchEvent(new Event("argos:ouvir"))} aria-label="Falar com o Argos">
            <Mic size={18} aria-hidden="true" />
          </button>
        )}
      </form>

      <section className={css.numeros} aria-label="Seu dia em números">
        {numeros.map((x) => (
          <Link key={x.rotulo} to={x.para} className={`${css.numero} ${x.alerta && x.n ? css.numeroAlerta : ""}`}>
            <strong>{x.carregando ? "–" : x.n}</strong>
            <span>{x.rotulo}</span>
          </Link>
        ))}
      </section>

      {inicio.isError && <MensagemErro erro={inicio.error} aoTentar={() => void inicio.refetch()} />}

      <div className={css.colunas}>
        <ProximaReuniao itens={agenda.data?.itens ?? []} carregando={agenda.isPending} google={agenda.data?.google} />
        <SuasTarefas />
      </div>

      {vencidos > 0 && (
        <Link to={inicio.data?.vencidos.length === 1 ? `/registros/${inicio.data.vencidos[0]!.codigo}` : "/biblioteca"} className={css.aviso}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            {vencidos === 1 ? `${inicio.data!.vencidos[0]!.codigo} precisa de revisão` : `${vencidos} registros precisam de revisão`}
          </span>
          <strong>Ver</strong>
        </Link>
      )}

      {!agenda.isPending && agenda.data?.google === "erro" && (
        <p className="suave pequeno" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <CalendarDays size={14} aria-hidden="true" /> Não consegui ler o Google Agenda agora.
        </p>
      )}
    </div>
  );
}
