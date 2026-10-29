import { Brain, FileSpreadsheet, Paperclip, Undo2, X } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/cliente";
import { useAvisar } from "../comum";
import { anexarPlanilha, anexo, conversa, useAnexo, type TurnoConversa } from "./conversa";
import css from "./Memoria.module.css";

/**
 * Transparência da memória numa resposta do Argos:
 * "Usei" = memórias do Cérebro que ele aplicou; "Guardei" = o que ele guardou sozinho (com Desfazer).
 */
export function MemoriaDaResposta({ t, aoAbrir, claro = false }: { t: TurnoConversa; aoAbrir?: () => void; claro?: boolean }) {
  const avisar = useAvisar();
  const [desfazendo, setDesfazendo] = useState<string | null>(null);
  const usadas = t.resposta?.memorias ?? [];
  const guardadas = t.guardadas ?? [];
  if (!usadas.length && !guardadas.length) return null;

  async function desfazer(registroId: string, titulo: string) {
    setDesfazendo(registroId);
    try {
      await api(`/registros/${registroId}/descartar`, { metodo: "POST", corpo: {} });
      conversa.esqueceu(t.id, registroId);
      avisar(`Esqueci: ${titulo}.`);
    } catch {
      avisar("Não consegui desfazer agora. Descarte em Revisar.", "erro");
    } finally {
      setDesfazendo(null);
    }
  }

  return (
    <div className={`${css.memoria} ${claro ? css.claro : ""}`}>
      {usadas.length > 0 && (
        <p className={css.linha}>
          <Brain size={13} aria-hidden="true" className={css.icone} />
          <span className={css.rotulo}>Usei</span>
          {usadas.map((m) => (
            <Link
              key={m.registroId}
              to={`/registros/${m.codigo}`}
              className={css.chip}
              onClick={aoAbrir}
              title={m.naoRevisada ? `${m.titulo} (ainda sem revisão)` : m.titulo}
            >
              <b>{m.codigo}</b> {m.titulo}
              {m.naoRevisada && <i className={css.naoRevisada}>não revisada</i>}
            </Link>
          ))}
        </p>
      )}
      {guardadas.map((g) => (
        <p key={g.registroId} className={`${css.linha} ${css.guardada}`}>
          <Brain size={13} aria-hidden="true" className={css.icone} />
          <span className={css.rotulo}>{g.acao === "nova" ? "Guardei" : "Atualizei"}</span>
          <Link to={`/registros/${g.codigo}`} className={css.chip} onClick={aoAbrir}>
            <b>{g.codigo}</b> {g.titulo}
          </Link>
          {g.acao === "nova" && (
            <button type="button" className={css.desfazer} disabled={desfazendo === g.registroId} onClick={() => void desfazer(g.registroId, g.titulo)}>
              <Undo2 size={12} aria-hidden="true" /> Desfazer
            </button>
          )}
        </p>
      ))}
    </div>
  );
}

/** Botão de clipe: anexa uma planilha (.xlsx ou .csv) para o Argos analisar. */
export function BotaoAnexar({ className, desabilitado }: { className?: string; desabilitado?: boolean }) {
  const avisar = useAvisar();
  const entrada = useRef<HTMLInputElement>(null);
  const [enviando, setEnviando] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={desabilitado || enviando}
        onClick={() => entrada.current?.click()}
        aria-label="Anexar planilha"
        title="Anexar planilha (.xlsx ou .csv)"
      >
        <Paperclip size={15} aria-hidden="true" />
      </button>
      <input
        ref={entrada}
        type="file"
        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        hidden
        onChange={(e) => {
          const arquivo = e.target.files?.[0];
          e.target.value = "";
          if (!arquivo) return;
          setEnviando(true);
          anexarPlanilha(arquivo).then(
            (a) => {
              const linhas = a.abas.reduce((s, x) => s + x.linhas, 0);
              avisar(`${a.nome} anexada: ${linhas.toLocaleString("pt-BR")} linhas. Pergunte o que quer saber.`);
            },
            (erro: Error) => avisar(erro.message || "Não consegui ler essa planilha.", "erro"),
          ).finally(() => setEnviando(false));
        }}
      />
    </>
  );
}

/** A planilha anexada, acima do campo de texto. */
export function ChipAnexo({ claro = false }: { claro?: boolean }) {
  const a = useAnexo();
  if (!a) return null;
  const linhas = a.abas.reduce((s, x) => s + x.linhas, 0);
  return (
    <div className={`${css.anexo} ${claro ? css.claro : ""}`}>
      <FileSpreadsheet size={14} aria-hidden="true" className={css.icone} />
      <span className={css.anexoNome}>{a.nome}</span>
      <span className={css.anexoInfo}>
        {a.abas.length > 1 ? `${a.abas.length} abas · ` : ""}
        {linhas.toLocaleString("pt-BR")} linhas
        {a.colunasOcultas.length ? ` · sem ${a.colunasOcultas.join(", ")}` : ""}
      </span>
      <button type="button" className={css.tirar} onClick={() => anexo.definir(null)} aria-label={`Tirar ${a.nome}`} title="Tirar a planilha">
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
