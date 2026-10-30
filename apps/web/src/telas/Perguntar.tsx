import type { ResumoConversaDTO } from "@cerebro/core/publico";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, BarChart3, CalendarPlus, FileSpreadsheet, Menu, Mic, MessageSquare, Plus, Search, ShieldCheck, Trash2, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/cliente";
import { conversa, useConversa } from "../componentes/argos/conversa";
import { controleArgos, perguntarAoArgos, useEstadoArgos, type FaseArgos } from "../componentes/argos/estado";
import { BotaoAnexar, ChipAnexo } from "../componentes/argos/Memoria";
import { Orbe, type EstadoOrbe } from "../componentes/argos/Orbe";
import { TurnoArgos } from "../componentes/argos/TurnoArgos";
import { useAvisar } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import css from "./Perguntar.module.css";

/**
 * Perguntar = a conversa com o Argos em tela cheia: lista de conversas salvas à esquerda,
 * a esfera e a conversa no painel escuro. Voz e texto passam pelo mesmo motor do Argos
 * (resposta falada, interrupção, memória, planilha anexada).
 */

const SUGESTOES = [
  "Como está a disponibilidade agora? Qual loja está mais crítica?",
  "Quantas entregas fizemos ontem e quantas atrasaram?",
  "Qual foi o faturamento da semana passada, em gráfico?",
  "Quais tarefas estão atrasadas?",
];

const CAPACIDADES = [
  { icone: BarChart3, titulo: "Pergunte sobre a operação", texto: "Disponibilidade, entregas, faturamento e saques, com tabela e gráfico." },
  { icone: Mic, titulo: "Fale ou digite", texto: "Segure Espaço e fale. Eu respondo em voz alta, e você pode me interromper." },
  { icone: CalendarPlus, titulo: "Anote na sua agenda", texto: "“Marca uma reunião com a supervisão amanhã às 15h.”" },
  { icone: FileSpreadsheet, titulo: "Analise uma planilha", texto: "Anexe um .xlsx ou .csv pelo clipe e diga como quer a análise." },
];

const ORBE: Record<FaseArgos, EstadoOrbe> = {
  fechado: "parado",
  pronto: "parado",
  ouvindo: "ouvindo",
  transcrevendo: "pensando",
  pensando: "pensando",
  falando: "falando",
  erro: "erro",
};

const STATUS: Record<FaseArgos, string> = {
  fechado: "Pronto",
  pronto: "Pronto",
  ouvindo: "Ouvindo",
  transcrevendo: "Entendendo",
  pensando: "Pensando",
  falando: "Respondendo",
  erro: "Algo deu errado",
};

const diaDe = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Bahia" });

/** Agrupa a lista como um app de chat: Hoje, Ontem, Últimos 7 dias, Antes. */
function agrupar(lista: ResumoConversaDTO[]) {
  const hoje = diaDe(new Date().toISOString());
  const ontem = diaDe(new Date(Date.now() - 864e5).toISOString());
  const semana = diaDe(new Date(Date.now() - 7 * 864e5).toISOString());
  const grupos: { nome: string; itens: ResumoConversaDTO[] }[] = [
    { nome: "Hoje", itens: [] },
    { nome: "Ontem", itens: [] },
    { nome: "Últimos 7 dias", itens: [] },
    { nome: "Antes", itens: [] },
  ];
  for (const c of lista) {
    const d = diaDe(c.atualizadoEm);
    grupos[d === hoje ? 0 : d === ontem ? 1 : d > semana ? 2 : 3]!.itens.push(c);
  }
  return grupos.filter((g) => g.itens.length);
}

function ListaConversas({ aoEscolher }: { aoEscolher?: () => void }) {
  const avisar = useAvisar();
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [termo, setTermo] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setTermo(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);
  const lista = useQuery({
    queryKey: ["conversas", termo],
    queryFn: () => api<ResumoConversaDTO[]>(`/conversas${termo ? `?busca=${encodeURIComponent(termo)}` : ""}`),
    staleTime: 10_000,
  });
  useEffect(() => {
    const atualizar = () => void qc.invalidateQueries({ queryKey: ["conversas"] });
    window.addEventListener("conversas:mudou", atualizar);
    return () => window.removeEventListener("conversas:mudou", atualizar);
  }, [qc]);
  const turnos = useConversa();
  const atual = conversa.idAtual();

  async function abrir(id: string) {
    if (id === atual) return aoEscolher?.();
    controleArgos.cancelar();
    try {
      await conversa.abrir(id);
      aoEscolher?.();
    } catch {
      avisar("Não consegui abrir essa conversa agora.", "erro");
    }
  }

  async function apagar(c: ResumoConversaDTO) {
    try {
      await conversa.apagar(c.id);
      avisar("Conversa apagada.");
    } catch {
      avisar("Não consegui apagar agora. Tente de novo.", "erro");
    }
  }

  const grupos = agrupar(lista.data ?? []);
  return (
    <div className={css.lista}>
      <div className={css.listaTopo}>
        <h2 className={css.listaTitulo}>Conversas</h2>
        <button
          type="button"
          className={css.nova}
          onClick={() => {
            controleArgos.cancelar();
            conversa.limpar();
            aoEscolher?.();
          }}
          disabled={!turnos.length}
        >
          <Plus size={14} aria-hidden="true" /> Nova conversa
        </button>
      </div>
      <div className={css.buscaLista}>
        <Search size={14} aria-hidden="true" />
        <label htmlFor="busca-conversas" className="so-leitor">
          Buscar nas conversas
        </label>
        <input id="busca-conversas" value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar nas conversas" autoComplete="off" />
      </div>

      <nav className={css.itens} aria-label="Conversas salvas">
        {lista.isPending ? null : grupos.length ? (
          grupos.map((g) => (
            <div key={g.nome} className={css.grupo}>
              <p className={css.grupoNome}>{g.nome}</p>
              <ul>
                {g.itens.map((c) => (
                  <li key={c.id} className={`${css.item} ${c.id === atual ? css.itemAtual : ""}`}>
                    <button type="button" className={css.itemAbrir} onClick={() => void abrir(c.id)} aria-current={c.id === atual ? "true" : undefined}>
                      <MessageSquare size={14} aria-hidden="true" />
                      <span className={css.itemTitulo}>{c.titulo}</span>
                    </button>
                    <button type="button" className={css.itemApagar} onClick={() => void apagar(c)} aria-label={`Apagar a conversa: ${c.titulo}`} title="Apagar">
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className={css.listaVazia}>
            {termo ? "Nenhuma conversa com isso." : "Suas conversas com o Argos aparecem aqui. Comece falando ou escrevendo ao lado."}
          </p>
        )}
      </nav>
      <p className={css.listaRodape}>Suas conversas ficam só com você. Apague quando quiser.</p>
    </div>
  );
}

export default function Perguntar() {
  const usuario = useUsuario();
  const navegar = useNavigate();
  const [params, setParams] = useSearchParams();
  const turnos = useConversa();
  const estado = useEstadoArgos();
  const [rascunho, setRascunho] = useState("");
  const [gaveta, setGaveta] = useState(false);
  const campo = useRef<HTMLTextAreaElement>(null);
  const fio = useRef<HTMLDivElement>(null);
  const ocupado = estado.fase === "transcrevendo" || estado.fase === "pensando";
  const vazio = turnos.length === 0;

  useEffect(() => {
    fio.current?.scrollTo({ top: fio.current.scrollHeight, behavior: "smooth" });
  }, [turnos, estado.fase]);

  function perguntar(textoBruto: string) {
    const texto = textoBruto.trim();
    if (texto.length < 2 || ocupado) return;
    setRascunho("");
    perguntarAoArgos(texto);
    campo.current?.focus();
  }

  // Pergunta vinda da busca do Início (?q=...).
  const q = params.get("q");
  useEffect(() => {
    if (q && q.trim().length >= 2) {
      setParams({}, { replace: true });
      // Espera o motor do Argos registrar o ouvinte (ele monta junto com a página).
      window.setTimeout(() => perguntarAoArgos(q.trim()), 60);
    } else if (!q) campo.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function enviar(e: FormEvent) {
    e.preventDefault();
    perguntar(rascunho);
  }

  function teclas(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      perguntar(rascunho);
    }
  }

  const primeiroNome = usuario.nome.split(" ")[0];
  const [pequena] = useState(() => window.innerWidth <= 860 || window.innerHeight < 760);
  const ouvindo = estado.fase === "ouvindo";

  return (
    <div className={css.tela}>
      <aside className={css.lateral} aria-label="Conversas">
        <ListaConversas />
      </aside>

      {gaveta && (
        <div className={css.gavetaFundo} onClick={() => setGaveta(false)}>
          <div className={css.gaveta} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Conversas">
            <button type="button" className={css.fecharGaveta} onClick={() => setGaveta(false)} aria-label="Fechar">
              <X size={18} aria-hidden="true" />
            </button>
            <ListaConversas aoEscolher={() => setGaveta(false)} />
          </div>
        </div>
      )}

      <section className={css.painel} aria-label="Conversa com o Argos">
        <header className={css.topo}>
          <button type="button" className={css.abrirLista} onClick={() => setGaveta(true)} aria-label="Ver conversas">
            <Menu size={18} aria-hidden="true" />
          </button>
          {!vazio && (
            <span className={css.orbeMini} aria-hidden="true">
              <Orbe estado={ORBE[estado.fase]} nivel={controleArgos.nivel} tamanho={34} />
            </span>
          )}
          <p className={css.status} aria-live="polite">
            <span className={`${css.ponto} ${css[`ponto_${estado.fase}`] ?? ""}`} aria-hidden="true" />
            Argos · {STATUS[estado.fase]}
            {ouvindo && estado.segundos > 0 ? ` · 0:${String(estado.segundos).padStart(2, "0")}` : ""}
          </p>
          <p className={css.privacidade}>
            <ShieldCheck size={14} aria-hidden="true" /> Só leitura na Central, sem dados pessoais
          </p>
          <button
            type="button"
            role="switch"
            className={css.botaoVoz}
            onClick={() => controleArgos.alternarMudo()}
            aria-checked={!estado.mudo}
            title={estado.mudo ? "O Argos responde só por escrito. Clique para ele voltar a falar." : "O Argos lê as respostas em voz alta. Clique para desligar."}
          >
            {estado.mudo ? <VolumeX size={15} aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
            <span>{estado.mudo ? "Voz desligada" : "Voz ligada"}</span>
          </button>
        </header>

        {vazio ? (
          <div className={css.boasVindas}>
            <button
              type="button"
              className={css.orbeGrande}
              onClick={() => controleArgos.falarOuEnviar()}
              aria-label={ouvindo ? "Enviar o que falei" : "Falar com o Argos"}
            >
              <Orbe estado={ORBE[estado.fase]} nivel={controleArgos.nivel} tamanho={pequena ? 120 : 180} />
            </button>
            <h1 className={css.saudacao}>
              {ouvindo ? "Estou ouvindo…" : ocupado ? "Pensando…" : `Oi, ${primeiroNome}. Eu sou o Argos.`}
            </h1>
            <p className={css.subtitulo}>
              Seu assistente da operação. Eu consulto disponibilidade, entregas, faturamento e os POPs da Tutts, respondo por voz ou por texto e lembro do que
              você me ensina.
            </p>
            <div className={css.capacidades}>
              {CAPACIDADES.map((c) => (
                <div key={c.titulo} className={css.capacidade}>
                  <c.icone size={18} aria-hidden="true" className={css.capIcone} />
                  <strong>{c.titulo}</strong>
                  <span>{c.texto}</span>
                </div>
              ))}
            </div>
            <div className={css.sugestoes} aria-label="Sugestões">
              {SUGESTOES.map((s) => (
                <button key={s} type="button" className={css.sugestao} onClick={() => perguntar(s)} disabled={ocupado}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={fio} className={css.fio} aria-live="polite">
            <div className={css.fioColuna}>
              {turnos.map((t) => (
                <TurnoArgos key={t.id} t={t} irPara={(destino) => navegar(destino)} fechar={() => undefined} />
              ))}
              {ouvindo && (
                <p className={css.ouvindo}>
                  <span className={css.pontoOuvindo} aria-hidden="true" /> Estou ouvindo… fale à vontade
                </p>
              )}
            </div>
          </div>
        )}

        <footer className={css.rodape}>
          <div className={css.rodapeColuna}>
            {estado.erro && estado.fase === "erro" && <p className={css.erro}>{estado.erro}</p>}
            <ChipAnexo />
            <form onSubmit={enviar} className={css.compositor}>
              <label htmlFor="nova" className="so-leitor">
                Sua pergunta
              </label>
              <textarea
                ref={campo}
                id="nova"
                rows={1}
                className={css.entrada}
                value={rascunho}
                onChange={(e) => setRascunho(e.target.value)}
                onKeyDown={teclas}
                placeholder={ouvindo ? "Estou ouvindo…" : "Pergunte ao Argos…"}
                autoComplete="off"
              />
              <BotaoAnexar className={css.anexar} desabilitado={ocupado} />
              {rascunho.trim().length >= 2 ? (
                <button type="submit" className={css.acaoPrincipal} disabled={ocupado} aria-label="Enviar" title="Enviar (Enter)">
                  <ArrowUp size={18} aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  className={`${css.acaoPrincipal} ${ouvindo ? css.acaoOuvindo : ""}`}
                  onClick={() => controleArgos.falarOuEnviar()}
                  disabled={ocupado}
                  aria-label={ouvindo ? "Enviar o que falei" : "Falar com o Argos"}
                  title={ouvindo ? "Enviar" : "Falar (ou segure Espaço)"}
                >
                  <Mic size={18} aria-hidden="true" />
                </button>
              )}
            </form>
            <p className={css.dica}>
              Segure <kbd>Espaço</kbd> para falar · <kbd>Enter</kbd> envia o que você digitou · o clipe anexa uma planilha
            </p>
          </div>
        </footer>
      </section>
    </div>
  );
}

