import type { RespostaAssistenteDTO } from "@cerebro/core/publico";
import { ArrowRight, ChevronDown, Keyboard, Mic, Volume2, VolumeX, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErroApi, api } from "../../api/cliente";
import { desbloquearFala, falar, pararFala } from "./fala";
import { Gravador } from "./gravador";
import { DadosCentral } from "./DadosCentral";
import { Orbe, type EstadoOrbe } from "./Orbe";
import css from "./Argos.module.css";

const Conteudo = lazy(() => import("../Conteudo").then((m) => ({ default: m.Conteudo })));

type Fase = "fechado" | "ouvindo" | "transcrevendo" | "pensando" | "falando" | "pronto" | "erro";
type Modo = "segurando" | "continuo";

// Segurar o espaço por mais que isso = "aperte e fale"; menos = toque, ouve até o silêncio.
const LIMIAR_SEGURAR_MS = 320;
const SILENCIO_FIM_MS = 1600;
const MAX_GRAVACAO_MS = 45_000;
const SEM_FALA_MS = 7000;

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
  const [fase, setFase] = useState<Fase>("fechado");
  const [modo, setModo] = useState<Modo>("segurando");
  const [texto, setTexto] = useState("");
  const [resposta, setResposta] = useState<RespostaAssistenteDTO | null>(null);
  const [erro, setErro] = useState<{ mensagem: string; digitar: boolean } | null>(null);
  const [mudo, setMudo] = useState(lerMudo);
  const [completo, setCompleto] = useState(false);
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
  // Conversa recente (some ao recarregar a página): deixa o Argos entender "e em Salvador?".
  const historico = useRef<{ pergunta: string; resposta: string; em: number }[]>([]);

  const nivel = useCallback(() => {
    if (faseRef.current === "ouvindo") return gravador.current.nivel();
    if (faseRef.current === "falando") {
      energia.current *= 0.9;
      return Math.min(1, energia.current + 0.12 + Math.sin(performance.now() / 140) * 0.06);
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
      setTexto(fala);
      setResposta(null);
      setCompleto(false);
      setFase("pensando");
      try {
        // Depois de 15 min parado, a conversa recomeça do zero.
        const recentes = historico.current.filter((h) => Date.now() - h.em < 15 * 60_000).slice(-4);
        const r = await api<RespostaAssistenteDTO>("/argos", {
          metodo: "POST",
          corpo: { texto: fala, historico: recentes.map(({ pergunta, resposta }) => ({ pergunta, resposta })) },
        });
        if (minha !== geracao.current) return;
        historico.current = [...recentes, { pergunta: fala, resposta: r.fala.slice(0, 2000), em: Date.now() }].slice(-4);
        setResposta(r);
        if (r.acao?.automatica) navegar(r.acao.destino);
        if (mudoRef.current) {
          setFase("pronto");
          return;
        }
        setFase("falando");
        energia.current = 1;
        falar(r.fala, {
          aoPalavra: () => {
            energia.current = 1;
          },
          aoFim: () => {
            if (geracao.current === minha && faseRef.current === "falando") setFase("pronto");
          },
        });
      } catch (e) {
        if (minha !== geracao.current) return;
        falhar(e instanceof ErroApi ? e.message : "Não consegui responder agora. Tente de novo.");
      }
    },
    [falhar, navegar],
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
      falhar("Foi rápido demais. Segure o espaço enquanto fala, ou digite abaixo.", true);
      return;
    }
    // O medidor de volume pode falhar em alguns navegadores (fica zerado com o microfone bom):
    // por isso ele nunca impede o envio. Quem decide se houve fala é a transcrição.
    console.info("[Argos] gravação", { duracaoMs: Math.round(duracao), bytes: audio.size, tipo: audio.type, falou, pico: Number(pico.toFixed(3)) });
    try {
      const { texto: transcrito } = await api<{ texto: string }>("/argos/transcrever", { metodo: "POST", arquivo: audio });
      if (minha !== geracao.current) return;
      // Sem fala, o Whisper às vezes "inventa" frases curtas de legenda.
      if (!transcrito.trim() || ALUCINACAO.test(transcrito.trim())) {
        falhar("Não entendi o que foi dito. Tente de novo, um pouco mais perto do microfone.");
        return;
      }
      await processar(transcrito);
    } catch (e) {
      if (minha !== geracao.current) return;
      const desligada = e instanceof ErroApi && e.status === 503;
      falhar(e instanceof ErroApi ? e.message : "Não consegui enviar o áudio. Confira sua internet.", desligada);
    }
  }, [falhar, processar]);

  const ouvir = useCallback(
    async (m: Modo) => {
      geracao.current++;
      pararFala();
      if (!mudoRef.current) desbloquearFala(); // ainda dentro do gesto (tecla/clique)
      setErro(null);
      setResposta(null);
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
    [falhar],
  );

  const fechar = useCallback(() => {
    geracao.current++;
    gravador.current.cancelar();
    pararFala();
    setFase("fechado");
    setErro(null);
  }, []);

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
        else if (!g.falou && d > SEM_FALA_MS) {
          if (g.pico < 0.004) void enviar();
          else {
            g.cancelar();
            falhar("Não ouvi nada. Tente de novo ou digite abaixo.", true);
          }
        }
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [fase, enviar, falhar]);

  // Atalhos globais: Espaço (segurar = falar; tocar = ouvir até o silêncio) e Esc.
  useEffect(() => {
    const descer = (e: KeyboardEvent) => {
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

  useEffect(() => () => gravador.current.cancelar(), []);

  // Outras telas podem mandar uma pergunta pronta (ex.: "Perguntar ao Argos" no mapa).
  useEffect(() => {
    const perguntar = (e: Event) => {
      const texto = (e as CustomEvent<string>).detail;
      if (typeof texto !== "string" || texto.trim().length < 2) return;
      gravador.current.cancelar();
      pararFala();
      if (!mudoRef.current) desbloquearFala();
      setErro(null);
      void processar(texto.trim());
    };
    window.addEventListener("argos:perguntar", perguntar);
    return () => window.removeEventListener("argos:perguntar", perguntar);
  }, [processar]);

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
    void processar(t);
  }

  const aberto = fase !== "fechado";
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
          <section className={css.painel} role="dialog" aria-modal="false" aria-label="Argos, assistente de voz">
            <header className={css.topo}>
              <span className={css.marca}>
                <span className={`${css.ponto} ${fase === "ouvindo" ? css.pontoAoVivo : ""}`} aria-hidden="true" />
                Argos
              </span>
              <span className={css.fase} aria-live="polite">
                {ROTULO[fase]}
                {fase === "ouvindo" && ` · 0:${String(segundos).padStart(2, "0")}`}
                {(fase === "transcrevendo" || fase === "pensando") && <span className={css.reticencias} aria-hidden="true" />}
              </span>
              <span className={css.acoesTopo}>
                <button type="button" className={css.icone} onClick={alternarMudo} aria-pressed={mudo} title={mudo ? "Ligar a voz" : "Silenciar a voz"} aria-label={mudo ? "Ligar a voz" : "Silenciar a voz"}>
                  {mudo ? <VolumeX size={16} aria-hidden="true" /> : <Volume2 size={16} aria-hidden="true" />}
                </button>
                <button type="button" className={css.icone} onClick={fechar} title="Fechar (Esc)" aria-label="Fechar">
                  <X size={16} aria-hidden="true" />
                </button>
              </span>
            </header>

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
              {texto && fase !== "ouvindo" && fase !== "transcrevendo" && <p className={css.voce}>“{texto}”</p>}
              {fase === "pensando" && <p className={css.convite}>Pensando e consultando os dados…</p>}
              {erro && <p className={css.erro}>{erro.mensagem}</p>}

              {resposta && (fase === "falando" || fase === "pronto") && (
                <div className={css.resposta}>
                  <p className={css.fala}>{resposta.fala}</p>
                  {resposta.dados && <DadosCentral dados={resposta.dados} />}
                  {resposta.fontes.length > 0 && (
                    <div className={css.fontes}>
                      {resposta.fontes.slice(0, 4).map((f) => (
                        <Link key={f.registroId} to={`/registros/${f.codigo}`} className={css.fonte} onClick={fechar}>
                          <span className={css.fonteCodigo}>{f.codigo}</span> {f.titulo}
                        </Link>
                      ))}
                    </div>
                  )}
                  {resposta.detalhe && (
                    <>
                      <button type="button" className={css.verMais} onClick={() => setCompleto((v) => !v)} aria-expanded={completo}>
                        {completo ? "Esconder resposta completa" : "Ver resposta completa"}
                        <ChevronDown size={14} aria-hidden="true" style={{ transform: completo ? "rotate(180deg)" : undefined }} />
                      </button>
                      {completo && (
                        <div className={css.completo}>
                          <Suspense fallback={null}>
                            <Conteudo
                              texto={resposta.detalhe.replace(/\[(\d+)\]/g, (marca, n: string) => {
                                const f = resposta.fontes.find((x) => x.indice === Number(n));
                                return f ? `[[${n}]](/registros/${f.codigo})` : marca;
                              })}
                            />
                          </Suspense>
                        </div>
                      )}
                    </>
                  )}
                  {resposta.acao && !resposta.acao.automatica && (
                    <button
                      type="button"
                      className={`botao botao-primario ${css.acao}`}
                      onClick={() => {
                        navegar(resposta.acao!.destino);
                        fechar();
                      }}
                    >
                      {resposta.acao.rotulo} <ArrowRight size={15} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
            </div>

            <footer className={css.rodape}>
              {fase === "ouvindo" && toque ? (
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
