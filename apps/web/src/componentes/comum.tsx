import type { StatusRegistro, TipoRegistro } from "@cerebro/core/publico";
import { AlertCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ErroApi } from "../api/cliente";
import { COR_STATUS, COR_TIPO, NOME_STATUS, nomeTipo } from "../util/formato";
import css from "./comum.module.css";

export function EtiquetaTipo({ tipo }: { tipo: TipoRegistro }) {
  return <span className={`etiqueta ${COR_TIPO[tipo]}`}>{nomeTipo(tipo)}</span>;
}

export function EtiquetaStatus({ status }: { status: StatusRegistro }) {
  return <span className={`etiqueta ${COR_STATUS[status]}`}>{NOME_STATUS[status]}</span>;
}

export function Esqueleto({ linhas = 3, altura = 16 }: { linhas?: number; altura?: number }) {
  return (
    <div className={css.esqueleto} aria-busy="true" aria-label="Carregando">
      {Array.from({ length: linhas }, (_, i) => (
        <div key={i} className="esqueleto" style={{ height: altura, width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** Estado vazio com uma ação clara. */
export function Vazio({ titulo, texto, acao }: { titulo: string; texto?: string; acao?: ReactNode }) {
  return (
    <div className={css.vazio}>
      <p className={css.vazioTitulo}>{titulo}</p>
      {texto && <p className="suave">{texto}</p>}
      {acao}
    </div>
  );
}

export function MensagemErro({ erro, aoTentar }: { erro: unknown; aoTentar?: () => void }) {
  const mensagem = erro instanceof ErroApi ? erro.message : "Não consegui carregar agora.";
  return (
    <div className="aviso aviso-erro" role="alert">
      <AlertCircle size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ flexGrow: 1 }}>{mensagem}</span>
      {aoTentar && (
        <button type="button" className="botao botao-pequeno" onClick={aoTentar}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

// ── Avisos rápidos (toasts) ──

interface Aviso {
  id: number;
  texto: string;
  tipo: "ok" | "erro";
}
const ContextoAvisos = createContext<(texto: string, tipo?: Aviso["tipo"]) => void>(() => {});

export function ProvedorAvisos({ children }: { children: ReactNode }) {
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const proximo = useRef(1);
  const avisar = useCallback((texto: string, tipo: Aviso["tipo"] = "ok") => {
    const id = proximo.current++;
    setAvisos((a) => [...a.slice(-2), { id, texto, tipo }]);
    setTimeout(() => setAvisos((a) => a.filter((x) => x.id !== id)), tipo === "erro" ? 6000 : 3500);
  }, []);
  return (
    <ContextoAvisos.Provider value={avisar}>
      {children}
      <div className={css.avisos} role="status" aria-live="polite">
        {avisos.map((a) => (
          <div key={a.id} className={`${css.toast} ${a.tipo === "erro" ? css.toastErro : ""}`}>
            {a.texto}
          </div>
        ))}
      </div>
    </ContextoAvisos.Provider>
  );
}
export const useAvisar = () => useContext(ContextoAvisos);

/** Mensagem amigável para qualquer erro de mutação. */
export function textoDoErro(erro: unknown) {
  return erro instanceof ErroApi ? erro.message : "Não deu certo agora. Tente de novo.";
}

/** Atalho de teclado simples, ignorado enquanto a pessoa digita. */
export function useAtalho(tecla: string, fn: () => void) {
  useEffect(() => {
    const ouvir = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement;
      if (alvo.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === tecla) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", ouvir);
    return () => window.removeEventListener("keydown", ouvir);
  }, [tecla, fn]);
}

/** Mostra o carregamento só se demorar (evita piscar em respostas rápidas). */
export function useAtraso(ativo: boolean, ms = 200) {
  const [mostrar, setMostrar] = useState(false);
  useEffect(() => {
    if (!ativo) return setMostrar(false);
    const t = setTimeout(() => setMostrar(true), ms);
    return () => clearTimeout(t);
  }, [ativo, ms]);
  return mostrar;
}
