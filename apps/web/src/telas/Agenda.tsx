import type { ItemAgendaDTO } from "@cerebro/core/publico";
import { AlarmClock, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, ListTodo, Plus, Users, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAgenda, useCriarLembrete } from "../api/agenda";
import { Esqueleto, MensagemErro, textoDoErro, useAvisar } from "../componentes/comum";
import { hora } from "../util/formato";
import css from "./Agenda.module.css";

const FUSO = "America/Bahia";
const diaDe = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: FUSO });
const hoje = () => diaDe(new Date());
const somar = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Segunda-feira da semana do dia. */
const segunda = (dia: string) => {
  const sem = new Date(`${dia}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return somar(dia, sem === 0 ? -6 : 1 - sem);
};
const diaDoItem = (i: ItemAgendaDTO) => (i.diaInteiro ? i.inicio.slice(0, 10) : diaDe(new Date(i.inicio)));

function duracao(i: ItemAgendaDTO) {
  if (i.diaInteiro || !i.fim) return i.tipo === "tarefa" ? (i.tarefa?.atrasada ? "atrasada" : "") : i.diaInteiro ? "todo" : "";
  const min = Math.round((new Date(i.fim).getTime() - new Date(i.inicio).getTime()) / 60_000);
  if (min <= 0) return "";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ""}`;
}

function Item({ i }: { i: ItemAgendaDTO }) {
  const [aberto, setAberto] = useState(false);
  const temDetalhe = i.tipo !== "tarefa" && (i.participantes.length > 0 || i.tarefas.length > 0 || i.url || i.chamada);
  const classe = i.tipo === "tarefa" ? css.itemTarefa : i.tipo === "lembrete" ? css.itemLembrete : "";
  const dentro = (
    <>
      <div className={css.quando}>
        <strong>{i.diaInteiro ? (i.tipo === "tarefa" ? "Prazo" : "Dia") : hora(i.inicio)}</strong>
        <span>{duracao(i)}</span>
      </div>
      <div className={css.corpo}>
        <span className={css.titulo}>{i.titulo}</span>
        <span className={css.detalhe}>
          {i.tipo === "tarefa" && i.tarefa
            ? `${i.tarefa.codigo}${i.tarefa.responsavel ? ` · ${i.tarefa.responsavel}` : ""}`
            : i.tipo === "lembrete"
              ? "Lembrete"
              : i.participantes.length
                ? `${i.participantes.length} ${i.participantes.length === 1 ? "participante" : "participantes"}`
                : i.chamada
                  ? "Google Meet"
                  : "Evento"}
        </span>
        <span className={css.etiquetas}>
          {i.chamada && <span className={css.etiqueta}>Meet</span>}
          {i.tarefas.length > 0 && (
            <span className={`${css.etiqueta} ${css.etiquetaAmbar}`}>
              {i.tarefas.length} {i.tarefas.length === 1 ? "tarefa" : "tarefas"} na pauta
            </span>
          )}
          {i.tipo === "tarefa" && <span className={`${css.etiqueta} ${css.etiquetaAmbar}`}>{i.tarefa?.atrasada ? "Tarefa atrasada" : "Tarefa"}</span>}
          {i.tipo === "lembrete" && <span className={`${css.etiqueta} ${css.etiquetaVerde}`}>Lembrete</span>}
        </span>
      </div>
      {temDetalhe && <ChevronDown size={16} aria-hidden="true" className={css.seta} style={{ transform: aberto ? "rotate(180deg)" : undefined }} />}
    </>
  );

  if (i.tipo === "tarefa" && i.tarefa) {
    return (
      <li>
        <Link to={`/tarefas?abrir=${i.tarefa.codigo}`} className={`${css.item} ${classe}`}>
          {dentro}
        </Link>
      </li>
    );
  }
  return (
    <li>
      <div className={`${css.item} ${classe} ${aberto ? css.itemAberto : ""}`}>
        <button type="button" className={css.alternar} onClick={() => setAberto((v) => !v)} aria-expanded={aberto} disabled={!temDetalhe}>
          {dentro}
        </button>
        {aberto && (
          <div className={css.expandido}>
            {i.tarefas.length > 0 && (
              <div className={css.bloco}>
                <span className={css.blocoTitulo}>
                  <ListTodo size={14} aria-hidden="true" /> Pauta
                </span>
                <ul className="lista">
                  {i.tarefas.map((t) => (
                    <li key={t.codigo}>
                      <Link to={`/tarefas?abrir=${t.codigo}`}>
                        <span className="mono pequeno suave">{t.codigo}</span> {t.titulo}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {i.participantes.length > 0 && (
              <div className={css.bloco}>
                <span className={css.blocoTitulo}>
                  <Users size={14} aria-hidden="true" /> Participantes
                </span>
                <p className="pequeno suave">{i.participantes.join(", ")}</p>
              </div>
            )}
            <div className={css.acoes}>
              {i.chamada && (
                <a href={i.chamada} target="_blank" rel="noreferrer" className="botao botao-primario botao-pequeno">
                  <Video size={14} aria-hidden="true" /> Entrar no Meet
                </a>
              )}
              {i.url && (
                <a href={i.url} target="_blank" rel="noreferrer" className="botao botao-pequeno">
                  <ExternalLink size={14} aria-hidden="true" /> Abrir no Google Agenda
                </a>
              )}
              <Link to="/tarefas" className="botao botao-pequeno">
                <Plus size={14} aria-hidden="true" /> Pôr tarefa na pauta
              </Link>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function NovoLembrete({ dia, fechar }: { dia: string; fechar: () => void }) {
  const caixa = useRef<HTMLDialogElement>(null);
  const criar = useCriarLembrete();
  const avisar = useAvisar();
  const [titulo, setTitulo] = useState("");
  const [data, setData] = useState(dia);
  const [horaTexto, setHoraTexto] = useState("09:00");
  const [diaTodo, setDiaTodo] = useState(false);

  useEffect(() => {
    const d = caixa.current;
    if (d && !d.open) d.showModal();
  }, []);

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (titulo.trim().length < 2) return;
    criar.mutate(
      { titulo: titulo.trim(), quando: diaTodo ? data : `${data}T${horaTexto}` },
      {
        onSuccess: () => {
          avisar("Lembrete criado na agenda.");
          fechar();
        },
      },
    );
  }

  return (
    <dialog ref={caixa} className={css.dialogo} onClose={fechar} aria-labelledby="t-lembrete">
      <form onSubmit={enviar} className={css.formLembrete}>
        <div className={css.dialogoTopo}>
          <h2 id="t-lembrete">Novo lembrete</h2>
          <button type="button" className="botao botao-fantasma botao-icone" onClick={fechar} aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="campo">
          <label htmlFor="l-titulo">O que lembrar</label>
          <input id="l-titulo" className="entrada" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="ex.: conferir os saques do dia" autoFocus required />
        </div>
        <div className={css.linhaCampos}>
          <div className="campo">
            <label htmlFor="l-dia">Dia</label>
            <input id="l-dia" type="date" className="entrada" value={data} onChange={(e) => setData(e.target.value)} required />
          </div>
          <div className="campo">
            <label htmlFor="l-hora">Hora</label>
            <input id="l-hora" type="time" className="entrada" value={horaTexto} onChange={(e) => setHoraTexto(e.target.value)} disabled={diaTodo} />
          </div>
        </div>
        <label className={css.check}>
          <input type="checkbox" checked={diaTodo} onChange={(e) => setDiaTodo(e.target.checked)} /> Dia todo
        </label>
        {criar.isError && (
          <p className="erro-campo" role="alert">
            {textoDoErro(criar.error)}
          </p>
        )}
        <div className={css.dialogoAcoes}>
          <button type="button" className="botao" onClick={fechar}>
            Cancelar
          </button>
          <button type="submit" className="botao botao-primario" disabled={criar.isPending || titulo.trim().length < 2}>
            {criar.isPending ? "Criando…" : "Criar lembrete"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export default function Agenda() {
  const [params, setParams] = useSearchParams();
  const hojeTexto = hoje();
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(params.get("dia") ?? "") ? params.get("dia")! : hojeTexto;
  const inicioSemana = segunda(dia);
  const agenda = useAgenda(inicioSemana, 7);
  const [lembrete, setLembrete] = useState(false);

  const porDia = useMemo(() => {
    const m = new Map<string, ItemAgendaDTO[]>();
    for (const i of agenda.data?.itens ?? []) {
      const d = diaDoItem(i);
      m.set(d, [...(m.get(d) ?? []), i]);
    }
    return m;
  }, [agenda.data]);

  const irPara = (d: string) => setParams(d === hojeTexto ? {} : { dia: d }, { replace: true });
  const dias = Array.from({ length: 7 }, (_, n) => somar(inicioSemana, n));
  const doDia = porDia.get(dia) ?? [];
  const titulo = new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long", timeZone: "UTC" });
  const mesBruto = new Date(`${inicioSemana}T12:00:00Z`).toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
  const mes = mesBruto.charAt(0).toUpperCase() + mesBruto.slice(1);

  return (
    <div className={css.pagina}>
      <header className={css.topo}>
        <div>
          <h1>Agenda</h1>
          <p className="suave">
            Reuniões, prazos das tarefas e lembretes, num só lugar.
            {agenda.data?.google === "ok" && (
              <>
                {" "}
                <Link to="/integracoes" className="pequeno">
                  Gerenciar conexão
                </Link>
              </>
            )}
          </p>
        </div>
        <button type="button" className={`botao botao-primario ${css.novoDesktop}`} onClick={() => setLembrete(true)}>
          <AlarmClock size={16} aria-hidden="true" /> Novo lembrete
        </button>
      </header>

      {agenda.data?.google === "desligada" && (
        <div className="aviso">
          <CalendarDays size={16} aria-hidden="true" /> O Google Agenda não está conectado: aqui aparecem só os prazos das tarefas.{" "}
          <Link to="/integracoes">Conectar</Link>
        </div>
      )}
      {agenda.data?.google === "erro" && <div className="aviso aviso-alerta">Não consegui ler o Google Agenda agora. Os prazos das tarefas aparecem normalmente.</div>}

      <div className={css.semana}>
        <div className={css.navSemana}>
          <span className={css.mes}>{mes}</span>
          <span className={css.navBotoes}>
            <button type="button" className="botao botao-fantasma botao-icone" onClick={() => irPara(somar(dia, -7))} aria-label="Semana anterior">
              <ChevronLeft size={18} aria-hidden="true" />
            </button>
            {dia !== hojeTexto && (
              <button type="button" className="botao botao-pequeno" onClick={() => irPara(hojeTexto)}>
                Hoje
              </button>
            )}
            <button type="button" className="botao botao-fantasma botao-icone" onClick={() => irPara(somar(dia, 7))} aria-label="Próxima semana">
              <ChevronRight size={18} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className={css.dias} role="tablist" aria-label="Dias da semana">
          {dias.map((d) => {
            const data = new Date(`${d}T12:00:00Z`);
            const qtd = porDia.get(d)?.length ?? 0;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={d === dia}
                className={`${css.dia} ${d === dia ? css.diaAtivo : ""} ${d === hojeTexto ? css.diaHoje : ""}`}
                onClick={() => irPara(d)}
                aria-label={`${data.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", timeZone: "UTC" })}, ${qtd} ${qtd === 1 ? "item" : "itens"}`}
              >
                <span>{data.toLocaleDateString("pt-BR", { weekday: "short", timeZone: "UTC" }).replace(".", "")}</span>
                <strong>{data.getUTCDate()}</strong>
                <i className={qtd ? css.ponto : css.semPonto} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </div>

      <section aria-labelledby="t-dia" className={css.lista}>
        <h2 id="t-dia" className={css.tituloDia}>
          {titulo}
        </h2>
        {agenda.isError ? (
          <MensagemErro erro={agenda.error} aoTentar={() => void agenda.refetch()} />
        ) : agenda.isPending ? (
          <Esqueleto linhas={4} altura={56} />
        ) : doDia.length ? (
          <ul className={`lista ${css.itens}`}>
            {doDia.map((i) => (
              <Item key={i.id} i={i} />
            ))}
          </ul>
        ) : (
          <div className={css.vazio}>
            <CalendarDays size={22} aria-hidden="true" />
            <p>Nada marcado para este dia.</p>
            <button type="button" className="botao botao-pequeno" onClick={() => setLembrete(true)}>
              <Plus size={14} aria-hidden="true" /> Criar um lembrete
            </button>
          </div>
        )}
      </section>

      <button type="button" className={css.fab} onClick={() => setLembrete(true)}>
        <Plus size={18} aria-hidden="true" /> Lembrete
      </button>

      {lembrete && <NovoLembrete dia={dia < hojeTexto ? hojeTexto : dia} fechar={() => setLembrete(false)} />}
    </div>
  );
}
