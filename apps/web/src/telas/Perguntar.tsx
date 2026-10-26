import type { FonteDTO, RespostaAssistenteDTO } from "@cerebro/core/publico";
import { ArrowRight, ArrowUp, Copy, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/cliente";
import { DadosCentral } from "../componentes/argos/DadosCentral";
import { conversa, useConversa } from "../componentes/argos/conversa";
import { useAvisar } from "../componentes/comum";
import { Conteudo } from "../componentes/Conteudo";
import { nomeTipo } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Perguntar.module.css";

/**
 * Perguntar = conversa por texto com o Argos.
 * O mesmo agente da voz: consulta os dados da Central (BI, disponibilidade, financeiro),
 * o conhecimento do Cérebro (POPs, regras, atas, documentos) e as tarefas.
 */

const SUGESTOES = [
  "Como está a disponibilidade agora? Qual loja está mais crítica?",
  "Quantas entregas fizemos ontem e quantas atrasaram?",
  "Qual foi o faturamento da semana passada?",
  "Quais tarefas estão atrasadas?",
  "Qual o procedimento quando o motoboy não aparece?",
];

/** Troca as citações [1] por links para o registro correspondente. */
function comCitacoes(texto: string, fontes: FonteDTO[]) {
  return texto.replace(/\[(\d+)\]/g, (marca, n: string) => {
    const f = fontes.find((x) => x.indice === Number(n));
    return f ? `[[${n}]](/registros/${f.codigo})` : marca;
  });
}

function Resposta({ r }: { r: RespostaAssistenteDTO }) {
  const avisar = useAvisar();
  const navegar = useNavigate();
  const texto = r.detalhe ?? r.fala;
  return (
    <div className={css.resposta}>
      <Conteudo texto={comCitacoes(texto, r.fontes)} />
      {r.dados && (
        <div className={css.painelDados}>
          <DadosCentral dados={r.dados} />
        </div>
      )}
      {r.fontes.length > 0 && (
        <div className={css.fontes}>
          <span className="suave pequeno">Fontes</span>
          <ul className={css.listaFontes}>
            {r.fontes.map((f) => (
              <li key={f.registroId}>
                <Link to={`/registros/${f.codigo}`} className={css.fonte}>
                  <span className={css.indice}>{f.indice}</span>
                  <span className="mono pequeno suave">{f.codigo}</span>
                  <span className={css.fonteTitulo}>{f.titulo}</span>
                  <span className="pequeno suave">{nomeTipo(f.tipo)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={css.acoes}>
        {r.acao && (
          <button type="button" className="botao botao-primario botao-pequeno" onClick={() => navegar(r.acao!.destino)}>
            {r.acao.rotulo} <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="botao botao-pequeno"
          onClick={() =>
            void navigator.clipboard.writeText(texto).then(
              () => avisar("Resposta copiada."),
              () => avisar("Não consegui copiar.", "erro"),
            )
          }
        >
          <Copy size={14} aria-hidden="true" /> Copiar
        </button>
        {r.intencao === "perguntar" && r.fontes.length === 0 && (
          <Link to={`/registros/novo?titulo=${encodeURIComponent(r.texto)}`} className="botao botao-pequeno">
            Documentar isso
          </Link>
        )}
      </div>
    </div>
  );
}

export default function Perguntar() {
  const [params, setParams] = useSearchParams();
  // Mesma conversa do painel do Argos: começar na voz e continuar aqui (ou o contrário).
  const turnos = useConversa();
  const [rascunho, setRascunho] = useState("");
  const [pensando, setPensando] = useState(false);
  const campo = useRef<HTMLTextAreaElement>(null);
  const fim = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnos, pensando]);

  async function perguntar(textoBruto: string) {
    const texto = textoBruto.trim();
    if (texto.length < 2 || pensando) return;
    // Contexto das últimas trocas (com o resumo das tabelas), para entender "e ontem?", "e na loja X?".
    const historico = conversa.historicoParaApi();
    const id = conversa.adicionar(texto);
    setRascunho("");
    setPensando(true);
    try {
      const r = await api<RespostaAssistenteDTO>("/argos", { metodo: "POST", corpo: { texto, historico } });
      conversa.responder(id, r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Não deu certo agora. Tente de novo.";
      conversa.falhar(id, msg);
    } finally {
      setPensando(false);
      campo.current?.focus();
    }
  }

  // Pergunta vinda da busca do Início (?q=...).
  const q = params.get("q");
  useEffect(() => {
    if (q && q.trim().length >= 2) {
      setParams({}, { replace: true });
      void perguntar(q);
    } else if (!q) campo.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function enviar(e: FormEvent) {
    e.preventDefault();
    void perguntar(rascunho);
  }

  function teclas(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void perguntar(rascunho);
    }
  }

  const vazio = turnos.length === 0;
  return (
    <div className={pg.pagina}>
      <div className={css.coluna}>
        <header className={css.topo}>
          <div className={pg.titulos}>
            <h1>Perguntar ao Argos</h1>
            <p className="suave">Dados da operação, regras, POPs, documentos e tarefas — pergunte do seu jeito.</p>
          </div>
          {!vazio && (
            <button type="button" className="botao botao-pequeno" onClick={() => conversa.limpar()} disabled={pensando}>
              <RotateCcw size={14} aria-hidden="true" /> Nova conversa
            </button>
          )}
        </header>

        {vazio && (
          <section className={css.sugestoes} aria-label="Sugestões">
            {SUGESTOES.map((s) => (
              <button key={s} type="button" className={css.sugestao} onClick={() => void perguntar(s)}>
                <Sparkles size={14} aria-hidden="true" /> {s}
              </button>
            ))}
          </section>
        )}

        <div className={css.conversa} aria-live="polite">
          {turnos.map((t) => (
            <article key={t.id} className={css.turno}>
              <p className={css.voce}>{t.pergunta}</p>
              {t.resposta && <Resposta r={t.resposta} />}
              {t.erro && (
                <div className="aviso aviso-erro">
                  {t.erro}{" "}
                  <button type="button" className="botao botao-pequeno" onClick={() => void perguntar(t.pergunta)} disabled={pensando}>
                    Tentar de novo
                  </button>
                </div>
              )}
              {!t.resposta && !t.erro && (
                <p className={css.pensando}>
                  Pensando e consultando os dados<span className={css.reticencias} aria-hidden="true" />
                </p>
              )}
            </article>
          ))}
          <div ref={fim} />
        </div>

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
            placeholder="Pergunte qualquer coisa sobre a operação…"
            autoComplete="off"
          />
          <button
            type="submit"
            className={`botao botao-primario ${css.enviar}`}
            disabled={pensando || rascunho.trim().length < 2}
            aria-label="Perguntar"
            title="Perguntar (Enter)"
          >
            <ArrowUp size={18} aria-hidden="true" />
          </button>
        </form>
        <p className="suave pequeno" style={{ marginTop: -8 }}>
          Enter envia · Shift+Enter quebra linha · consulta a Central só para leitura, sem dados pessoais.
        </p>
      </div>
    </div>
  );
}
