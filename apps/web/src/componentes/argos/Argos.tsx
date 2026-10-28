import type { RespostaAssistenteDTO } from "@cerebro/core/publico";
import { ArrowRight, ChevronDown, Keyboard, Maximize2, Mic, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ErroApi, api } from "../../api/cliente";
import { desbloquearFala, falar, nivelFala, pararFala } from "./fala";
import { Escuta, Gravador } from "./gravador";
import { DadosCentral } from "./DadosCentral";
import { conversa as fio, useConversa, type TurnoConversa } from "./conversa";
import { Orbe, type EstadoOrbe } from "./Orbe";
import css from "./Argos.module.css";

const Conteudo = lazy(() => import("../Conteudo").then((m) => ({ default: m.Conteudo })));

type Fase = "fechado" | "ouvindo" | "transcrevendo" | "pensando" | "falando" | "pronto" | "erro";
type Modo = "segurando" | "continuo";

// Segurar o espaço por mais que isso = "aperte e fale"; menos = toque, ouve até o silêncio.
const LIMIAR_SEGURAR_MS = 320;
const SILENCIO_FIM_MS = 1000;
const MAX_GRAVACAO_MS = 45_000;
const SEM_FALA_MS = 7000;
// No modo conversa, se a pessoa não disser nada depois da resposta, o Argos para de ouvir sem alarde.
const SEM_FALA_CONVERSA_MS = 6500;
// "Obrigado", "valeu", "tchau"... encerram a conversa.
const DESPEDIDA = /^(obrigad[oa]|valeu|tchau|at[eé] (mais|logo)|(era|é) s[oó] isso|pode parar|encerrar|chega|beleza,? obrigad[oa])\b/i;
const limparTranscricao = (t: string) => t.replace(/\s*\[áudio pouco claro\]\s*$/i, "").trim();

const CHAVE_MUDO = "cerebro:argos-mudo";
const lerMudo = () => {
  try {
    return localStorage.getItem(CHAVE_MUDO) === "1";
  } catch {
    return false;
  }
};

function editavel(alvo: EventTarget | null) {
  const el = alvo as HTMLElement | null;
  return !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
}

const ROTULO: Record<Fase, string> = {
  fechado: "",
  ouvindo: "Ouvindo",
  transcrevendo: "Entendendo",
  pensando: "Pensando",
  falando: "Respondendo",
  pronto: "Pronto",
  erro: "Algo deu errado",
};

const ESTADO_ORBE: Record<Fase, EstadoOrbe> = {
  fechado: "parado",
  ouvindo: "ouvindo",
  transcrevendo: "pensando",
  pensando: "pensando",
  falando: "falando",
  pronto: "parado",
  erro: "erro",
};

/** O Argos: assistente de voz disponível em qualquer tela. Segure Espaço para falar. */
const ALUCINACAO = /^(obrigad[oa]( por assistir)?|tchau|legendas?\b.*|inscreva-se.*|\.+|…)[.!]*$/i;

export function Argos() {
  const navegar = useNavigate();
  const qc = useQueryClient();
  const [fase, setFase] = useState<Fase>("fechado");
  const [modo, setModo] = useState<Modo>("segurando");
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState<{ mensagem: string; digitar: boolean } | null>(null);
  const [mudo, setMudo] = useState(lerMudo);
  const [digitado, setDigitado] = useState("");
  const [segundos, setSegundos] = useState(0);
  const [movimento] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [toque] = useState(() => window.matchMedia("(pointer: coarse)").matches);

  const gravador = useRef(new Gravador());
  const faseRef = useRef(fase);
  faseRef.current = fase;
  const modoRef = useRef(modo);
  modoRef.current = modo;
  const mudoRef = useRef(mudo);
  mudoRef.current = mudo;
  const espacoDesde = useRef(0);
  const energia = useRef(0);
  const campo = useRef<HTMLInputElement>(null);
  const geracao = useRef(0); // invalida respostas de pedidos cancelados
  // A conversa (compartilhada com a tela Perguntar): o histórico dá contexto para "e em Salvador?".
  const turnos = useConversa();
  const fioRef = useRef<HTMLDivElement>(null);
  // Modo conversa (como a voz do ChatGPT): depois de responder, o Argos volta a ouvir sozinho,
  // e dá para interromper falando por cima. Liga quando a pessoa fala; desliga ao digitar, fechar ou se despedir.
  const [conversa, setConversa] = useState(false);
  const conversaRef = useRef(false);
  const mudarConversa = useCallback((v: boolean) => {
    conversaRef.current = v;
    setConversa(v);
  }, []);
  const automatico = useRef(false); // a escuta atual começou sozinha (depois de uma resposta)
  const escuta = useRef(new Escuta());
  const ouvirRef = useRef<(m: Modo, auto?: boolean) => Promise<void>>(async () => undefined);

  const nivel = useCallback(() => {
    if (faseRef.current === "ouvindo") return gravador.current.nivel();
    if (faseRef.current === "falando") {
      const real = nivelFala();
      if (real !== null) return real;
      // Sem acesso ao áudio: um ritmo de sílabas (envelope que sobe e desce) em vez de um pulso fixo.
      energia.current *= 0.9;
      const t = performance.now() / 1000;
      const silabas = Math.abs(Math.sin(t * 7.3)) * 0.55 + Math.abs(Math.sin(t * 3.1 + 1)) * 0.3;
      return Math.min(1, 0.15 + silabas * 0.6 + energia.current * 0.25);
    }
    return 0;
  }, []);

  const falhar = useCallback((mensagem: string, digitar = false) => {
    setErro({ mensagem, digitar });
    setFase("erro");
    if (digitar) setTimeout(() => campo.current?.focus(), 50);
  }, []);

  const processar = useCallback(
    async (fala: string) => {
      const minha = ++geracao.current;
      setTexto(limparTranscricao(fala));
      setFase("pensando");
      const historico = fio.historicoParaApi();
      const id = fio.adicionar(limparTranscricao(fala));
      try {
        const r = await api<RespostaAssistenteDTO>("/argos", { metodo: "POST", corpo: { texto: fala, historico, falar: !mudoRef.current } });
        if (minha !== geracao.current) {
          fio.remover(id);
          return;
        }
        fio.responder(id, r);
        // O Argos pode ter criado tarefa, reunião ou rascunho: as telas abertas se atualizam.
        void qc.invalidateQueries({ queryKey: ["tarefas"] });
        void qc.invalidateQueries({ queryKey: ["agenda"] });
        if (r.acao?.automatica) {
          navegar(r.acao.destino);
          // Abriu uma tela: a pessoa vai olhar para ela; a conversa só continua se o Argos tiver perguntado algo.
          if (!r.aguardaResposta) mudarConversa(false);
        }
        // Depois da resposta: em conversa, volta a ouvir sozinho.
        const continuar = () => {
          if (geracao.current !== minha) return;
          if (conversaRef.current) void ouvirRef.current("continuo", true);
          else setFase("pronto");
        };
        if (mudoRef.current) {
          setFase("pronto");
          if (conversaRef.current) window.setTimeout(continuar, 500);
          return;
        }
        setFase("falando");
        energia.current = 1;
        falar(r.fala, {
          aoPalavra: () => {
            energia.current = 1;
          },
          aoFim: () => {
            if (geracao.current === minha && faseRef.current === "falando") continuar();
          },
        }, r.voz);
      } catch (e) {
        if (minha !== geracao.current) {
          fio.remover(id);
          return;
        }
        const msg = e instanceof ErroApi ? e.message : "Não consegui responder agora. Tente de novo.";
        fio.falhar(id, msg);
        setFase("erro");
      }
    },
    [falhar, navegar, qc, mudarConversa],
  );

  const enviar = useCallback(async () => {
    if (faseRef.current !== "ouvindo") return;
    const minha = ++geracao.current;
    const duracao = gravador.current.duracao();
    const falou = gravador.current.falou;
    const pico = gravador.current.pico;
    setFase("transcrevendo");
    const audio = await gravador.current.parar();
    if (minha !== geracao.current) return;
    if (duracao < 450 || audio.size < 1000) {
      if (automatico.current) {
        setFase("pronto");
        return;
      }
      falhar("Foi rápido demais. Segure o espaço enquanto fala, ou digite abaixo.", true);
      return;
    }
    // O medidor de volume pode falhar em alguns navegadores (fica zerado com o microfone bom):
    // por isso ele nunca impede o envio. Quem decide se houve fala é a transcrição.
    console.info("[Argos] gravação", { duracaoMs: Math.round(duracao), bytes: audio.size, tipo: audio.type, falou, pico: Number(pico.toFixed(3)) });
    try {
      const { texto: transcrito } = await api<{ texto: string }>("/argos/transcrever", { metodo: "POST", arquivo: audio });
      if (minha !== geracao.current) return;
      const limpo = limparTranscricao(transcrito);
      // "Obrigado, era só isso": encerra a conversa com educação.
      if (falou && limpo.length < 40 && DESPEDIDA.test(limpo)) {
        mudarConversa(false);
        setTexto(limpo);
        setFase("pronto");
        if (!mudoRef.current) falar("De nada! Qualquer coisa, é só chamar.");
        return;
      }
      // Sem fala, o Whisper às vezes "inventa" frases curtas de legenda.
      if (!limpo || ALUCINACAO.test(limpo)) {
        if (automatico.current) {
          // Na escuta automática, silêncio/ruído só encerra a escuta, sem erro.
          mudarConversa(false);
          setFase("pronto");
          return;
        }
        falhar("Não entendi o que foi dito. Tente de novo, um pouco mais perto do microfone.");
        return;
      }
      await processar(transcrito);
    } catch (e) {
      if (minha !== geracao.current) return;
      const desligada = e instanceof ErroApi && e.status === 503;
      falhar(e instanceof ErroApi ? e.message : "Não consegui enviar o áudio. Confira sua internet.", desligada);
    }
  }, [falhar, processar, mudarConversa]);

  const ouvir = useCallback(
    async (m: Modo, auto = false) => {
      geracao.current++;
      escuta.current.parar();
      pararFala();
      // Ainda dentro do gesto (tecla/clique). Na escuta automática não há gesto, e o áudio já foi liberado.
      if (!mudoRef.current && !auto) desbloquearFala();
      automatico.current = auto;
      if (!auto) mudarConversa(true); // falou com o Argos = modo conversa
      setErro(null);
      setTexto("");
      setModo(m);
      setSegundos(0);
      if (!Gravador.suportado()) {
        falhar("Este navegador não grava áudio. Digite a sua pergunta abaixo.", true);
        return;
      }
      setFase("ouvindo");
      try {
        await gravador.current.iniciar();
      } catch (e) {
        const negado = (e as DOMException)?.name === "NotAllowedError";
        falhar(
          negado
            ? "O microfone está bloqueado. Libere no cadeado ao lado do endereço do site e tente de novo."
            : "Não encontrei um microfone. Confira se ele está conectado, ou digite abaixo.",
          true,
        );
      }
    },
    [falhar, mudarConversa],
  );
  ouvirRef.current = ouvir;

  // A conversa rola sozinha para a última mensagem.
  useEffect(() => {
    const el = fioRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: movimento ? "smooth" : "auto" });
  }, [turnos, fase, movimento]);

  const fechar = useCallback(() => {
    geracao.current++;
    gravador.current.cancelar();
    escuta.current.parar();
    pararFala();
    mudarConversa(false);
    setFase("fechado");
    setErro(null);
  }, [mudarConversa]);

  // Enquanto o Argos fala em modo conversa: se a pessoa falar por cima, ele para e escuta.
  useEffect(() => {
    if (fase !== "falando" || !conversa) return;
    const e = escuta.current;
    void e.iniciar(() => {
      if (faseRef.current === "falando") void ouvirRef.current("continuo", true);
    });
    return () => e.parar();
  }, [fase, conversa]);

  // Enquanto ouve: cronômetro, fim por silêncio (modo toque) e limites de segurança.
  useEffect(() => {
    if (fase !== "ouvindo") return;
    const id = window.setInterval(() => {
      const g = gravador.current;
      const d = g.duracao();
      setSegundos(Math.floor(d / 1000));
      if (!d) return;
      if (d > MAX_GRAVACAO_MS) void enviar();
      else if (modoRef.current === "continuo") {
        if (g.falou && performance.now() - g.ultimaVoz > SILENCIO_FIM_MS) void enviar();
        // Sem medidor confiável (pico zerado), não dá para saber se a pessoa parou: envia no tempo limite.
        else if (!g.falou && automatico.current && g.pico >= 0.004 && d > SEM_FALA_CONVERSA_MS) {
          // Ninguém falou depois da resposta: encerra a conversa em silêncio.
          g.cancelar();
          mudarConversa(false);
          setFase("pronto");
        } else if (!g.falou && d > SEM_FALA_MS) {
          if (g.pico < 0.004) void enviar();
          else {
            g.cancelar();
            falhar("Não ouvi nada. Tente de novo ou digite abaixo.", true);
          }
        }
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [fase, enviar, falhar, mudarConversa]);

  // Atalhos globais: Espaço (segurar = falar; tocar = ouvir até o silêncio) e Esc.
  useEffect(() => {
    const descer = (e: KeyboardEvent) => {
      // Com uma janela aberta por cima (tabela ampliada), o Esc fecha só ela.
      if (e.key === "Escape" && document.querySelector("dialog[open]")) return;
      if (e.key === "Escape" && faseRef.current !== "fechado") {
        e.preventDefault();
        fechar();
        return;
      }
      if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || editavel(e.target)) return;
      e.preventDefault();
      if (faseRef.current === "ouvindo") {
        if (modoRef.current === "continuo") void enviar();
        return;
      }
      espacoDesde.current = performance.now();
      void ouvir("segurando");
    };
    const subir = (e: KeyboardEvent) => {
      if (e.code !== "Space" || editavel(e.target)) return;
      e.preventDefault();
      if (faseRef.current !== "ouvindo" || modoRef.current !== "segurando") return;
      if (performance.now() - espacoDesde.current < LIMIAR_SEGURAR_MS) setModo("continuo");
      else void enviar();
    };
    window.addEventListener("keydown", descer);
    window.addEventListener("keyup", subir);
    return () => {
      window.removeEventListener("keydown", descer);
      window.removeEventListener("keyup", subir);
    };
  }, [enviar, fechar, ouvir]);

  useEffect(
    () => () => {
      gravador.current.cancelar();
      escuta.current.parar();
    },
    [],
  );

  // Outras telas podem mandar uma pergunta pronta (ex.: "Perguntar ao Argos" no mapa).
  useEffect(() => {
    const perguntar = (e: Event) => {
      const texto = (e as CustomEvent<string>).detail;
      if (typeof texto !== "string" || texto.trim().length < 2) return;
      gravador.current.cancelar();
      pararFala();
      if (!mudoRef.current) desbloquearFala();
      mudarConversa(false);
      setErro(null);
      void processar(texto.trim());
    };
    window.addEventListener("argos:perguntar", perguntar);
    return () => window.removeEventListener("argos:perguntar", perguntar);
  }, [processar, mudarConversa]);

  // Botão do Argos na barra de baixo (celular) abre a escuta.
  useEffect(() => {
    const abrir = () => {
      if (faseRef.current === "fechado" || faseRef.current === "pronto" || faseRef.current === "erro") void ouvir("continuo");
    };
    window.addEventListener("argos:ouvir", abrir);
    return () => window.removeEventListener("argos:ouvir", abrir);
  }, [ouvir]);

  function alternarMudo() {
    const novo = !mudo;
    setMudo(novo);
    try {
      localStorage.setItem(CHAVE_MUDO, novo ? "1" : "0");
    } catch {
      /* sem armazenamento: vale só nesta sessão */
    }
    if (novo) {
      pararFala();
      if (fase === "falando") setFase("pronto");
    }
  }

  function enviarDigitado(e: FormEvent) {
    e.preventDefault();
    const t = digitado.trim();
    if (t.length < 2) return;
    setDigitado("");
    setErro(null);
    mudarConversa(false);
    void processar(t);
  }

  const aberto = fase !== "fechado";
  const temTurnos = turnos.length > 0;
  const temDados = turnos.some((t) => t.resposta?.dados);
  const podeDigitar = fase === "pronto" || fase === "erro";

  return (
    <>
      {!aberto && (
        <button type="button" className={css.lancador} onClick={() => void ouvir("continuo")} aria-label="Falar com o Argos (segure Espaço)">
          <Orbe estado="parado" nivel={nivel} tamanho={52} movimento={movimento} />
          <span className={css.dicaLancador} role="tooltip">
            Falar com o Argos <kbd>Segure Espaço</kbd>
          </span>
        </button>
      )}

      {aberto && (
        <div className={css.camada} onMouseDown={(e) => e.target === e.currentTarget && fase !== "ouvindo" && fechar()}>
          <section
            className={`${css.painel} ${temTurnos ? css.painelChat : ""} ${temDados ? css.painelLargo : ""}`}
            role="dialog"
            aria-modal="false"
            aria-label="Argos, assistente de voz"
          >
            <header className={css.topo}>
              {temTurnos && (
                <button
                  type="button"
                  className={css.orbeMini}
                  onClick={() => (fase === "ouvindo" ? void enviar() : fase !== "transcrevendo" && fase !== "pensando" ? void ouvir("continuo") : undefined)}
                  aria-label={fase === "ouvindo" ? "Enviar" : "Falar"}
                  title={fase === "ouvindo" ? "Enviar" : "Falar"}
                >
                  <Orbe estado={ESTADO_ORBE[fase]} nivel={nivel} tamanho={38} movimento={movimento} />
                </button>
              )}
              <span className={css.marca}>
                <span className={`${css.ponto} ${fase === "ouvindo" || conversa ? css.pontoAoVivo : ""}`} aria-hidden="true" />
                Argos{conversa && <span className={css.modoConversa}>conversa</span>}
              </span>
              <span className={css.fase} aria-live="polite">
                {ROTULO[fase]}
                {fase === "ouvindo" && ` · 0:${String(segundos).padStart(2, "0")}`}
                {(fase === "transcrevendo" || fase === "pensando") && <span className={css.reticencias} aria-hidden="true" />}
              </span>
              <span className={css.acoesTopo}>
                {temTurnos && (
                  <>
                    <button
                      type="button"
                      className={css.icone}
                      onClick={() => {
                        geracao.current++;
                        gravador.current.cancelar();
                        escuta.current.parar();
                        pararFala();
                        mudarConversa(false);
                        fio.limpar();
                        setErro(null);
                        setFase("pronto");
                      }}
                      title="Nova conversa"
                      aria-label="Nova conversa"
                    >
                      <RotateCcw size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={css.icone}
                      onClick={() => {
                        navegar("/perguntar");
                        fechar();
                      }}
                      title="Abrir em tela cheia"
                      aria-label="Abrir a conversa em tela cheia"
                    >
                      <Maximize2 size={15} aria-hidden="true" />
                    </button>
                  </>
                )}
                <button type="button" className={css.icone} onClick={alternarMudo} aria-pressed={mudo} title={mudo ? "Ligar a voz" : "Silenciar a voz"} aria-label={mudo ? "Ligar a voz" : "Silenciar a voz"}>
                  {mudo ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                </button>
                <button type="button" className={css.icone} onClick={fechar} title="Fechar (Esc)" aria-label="Fechar">
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            </header>

            {!temTurnos ? (
              <>
                <button
                  type="button"
                  className={css.palco}
                  onClick={() => (fase === "ouvindo" ? void enviar() : fase !== "transcrevendo" && fase !== "pensando" ? void ouvir("continuo") : undefined)}
                  aria-label={fase === "ouvindo" ? "Enviar" : "Falar de novo"}
                >
                  <Orbe estado={ESTADO_ORBE[fase]} nivel={nivel} tamanho={148} movimento={movimento} />
                </button>
                <div className={css.conversa} aria-live="polite">
                  {fase === "ouvindo" && <p className={css.convite}>{segundos < 1 ? "Pode falar…" : "Estou ouvindo"}</p>}
                  {fase === "transcrevendo" && <p className={css.convite}>Entendendo o que você disse…</p>}
                  {(fase === "pronto" || fase === "erro") && !erro && <p className={css.convite}>Pergunte sobre a operação, peça uma tarefa ou marque uma reunião.</p>}
                  {erro && <p className={css.erro}>{erro.mensagem}</p>}
                </div>
              </>
            ) : (
              <div ref={fioRef} className={css.fio} aria-live="polite">
                {turnos.map((t) => (
                  <TurnoArgos
                    key={t.id}
                    t={t}
                    irPara={(destino) => {
                      navegar(destino);
                      fechar();
                    }}
                    fechar={fechar}
                  />
                ))}
                {fase === "ouvindo" && (
                  <p className={css.statusFio}>
                    <span className={css.pontoOuvindo} aria-hidden="true" />
                    {automatico.current && segundos < 2 ? "Pode continuar…" : "Estou ouvindo…"}
                  </p>
                )}
                {fase === "transcrevendo" && <p className={css.statusFio}>Entendendo o que você disse…</p>}
                {erro && <p className={css.erro}>{erro.mensagem}</p>}
              </div>
            )}

            <footer className={css.rodape}>
              {conversa && (fase === "falando" || fase === "ouvindo") ? (
                <p className={css.dica}>
                  {fase === "falando" ? "Pode me interromper falando" : "Paro quando você terminar de falar"} ·{" "}
                  {toque ? "toque fora para encerrar" : <><kbd>Esc</kbd> encerra</>}
                </p>
              ) : fase === "ouvindo" && toque ? (
                <p className={css.dica}>Paro quando você terminar de falar · ou toque na esfera</p>
              ) : fase === "ouvindo" ? (
                <p className={css.dica}>
                  {modo === "segurando" ? (
                    <>
                      Solte o <kbd>Espaço</kbd> para enviar
                    </>
                  ) : (
                    <>
                      Paro quando você terminar de falar · ou toque no <kbd>Espaço</kbd>
                    </>
                  )}{" "}
                  · <kbd>Esc</kbd> cancela
                </p>
              ) : podeDigitar ? (
                <form className={css.digitar} onSubmit={enviarDigitado}>
                  <Keyboard size={15} aria-hidden="true" className={css.iconeDigitar} />
                  <label htmlFor="argos-texto" className="so-leitor">
                    Escreva para o Argos
                  </label>
                  <input
                    ref={campo}
                    id="argos-texto"
                    className={css.entrada}
                    value={digitado}
                    onChange={(e) => setDigitado(e.target.value)}
                    placeholder="Ou escreva aqui…"
                    autoComplete="off"
                  />
                  <button type="button" className={css.microfone} onClick={() => void ouvir("continuo")} aria-label="Falar" title="Falar (segure Espaço)">
                    <Mic size={15} aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <p className={css.dica}>{toque ? "Toque fora para fechar" : <><kbd>Esc</kbd> cancela</>}</p>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

/** Uma troca da conversa: o que a pessoa disse e a resposta do Argos (com dados, fontes e ação). */
function TurnoArgos({ t, irPara, fechar }: { t: TurnoConversa; irPara: (destino: string) => void; fechar: () => void }) {
  const [completo, setCompleto] = useState(false);
  const r = t.resposta;
  return (
    <article className={css.turno}>
      <p className={css.bolhaVoce}>{t.pergunta}</p>
      {!r && !t.erro && (
        <p className={css.statusFio}>
          Pensando e consultando os dados<span className={css.reticencias} aria-hidden="true" />
        </p>
      )}
      {t.erro && <p className={css.erro}>{t.erro}</p>}
      {r && (
        <div className={css.bolhaArgos}>
          <p className={css.falaTurno}>{r.fala}</p>
          {r.dados && <DadosCentral dados={r.dados} compacto />}
          {r.fontes.length > 0 && (
            <div className={css.fontesTurno}>
              {r.fontes.slice(0, 4).map((f) => (
                <Link key={f.registroId} to={`/registros/${f.codigo}`} className={css.fonte} onClick={fechar}>
                  <span className={css.fonteCodigo}>{f.codigo}</span> {f.titulo}
                </Link>
              ))}
            </div>
          )}
          {r.detalhe && (
            <>
              <button type="button" className={css.verMais} onClick={() => setCompleto((v) => !v)} aria-expanded={completo}>
                {completo ? "Esconder resposta completa" : "Ver resposta completa"}
                <ChevronDown size={14} aria-hidden="true" style={{ transform: completo ? "rotate(180deg)" : undefined }} />
              </button>
              {completo && (
                <div className={css.completo}>
                  <Suspense fallback={null}>
                    <Conteudo
                      texto={r.detalhe.replace(/\[(\d+)\]/g, (marca, n: string) => {
                        const f = r.fontes.find((x) => x.indice === Number(n));
                        return f ? `[[${n}]](/registros/${f.codigo})` : marca;
                      })}
                    />
                  </Suspense>
                </div>
              )}
            </>
          )}
          {r.acao && !r.acao.automatica && (
            <button type="button" className={`botao botao-primario botao-pequeno ${css.acaoTurno}`} onClick={() => irPara(r.acao!.destino)}>
              {r.acao.rotulo} <ArrowRight size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </article>
  );
}
