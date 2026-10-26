import type { UsuarioDTO } from "@cerebro/core/publico";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { aoExpirarSessao, api, definirToken, renovarSessao, type RespostaSessao } from "../api/cliente";

type Estado = { tipo: "carregando" } | { tipo: "anonimo"; expirou?: boolean } | { tipo: "logado"; usuario: UsuarioDTO };

interface ValorSessao {
  estado: Estado;
  usuario: UsuarioDTO | null;
  entrar(email: string, senha: string): Promise<void>;
  sair(): Promise<void>;
}

const Contexto = createContext<ValorSessao | null>(null);

export function ProvedorSessao({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<Estado>({ tipo: "carregando" });
  const cliente = useQueryClient();

  // Ao abrir a página, tenta retomar a sessão pelo cookie.
  useEffect(() => {
    void renovarSessao().then((s) => setEstado(s ? { tipo: "logado", usuario: s.usuario } : { tipo: "anonimo" }));
    return aoExpirarSessao(() => {
      cliente.clear();
      setEstado({ tipo: "anonimo", expirou: true });
    });
  }, [cliente]);

  const entrar = useCallback(async (email: string, senha: string) => {
    const s = await api<RespostaSessao>("/auth/entrar", { metodo: "POST", corpo: { email, senha } });
    definirToken(s.tokenAcesso);
    setEstado({ tipo: "logado", usuario: s.usuario });
  }, []);

  const sair = useCallback(async () => {
    await api("/auth/sair", { metodo: "POST" }).catch(() => undefined);
    definirToken(null);
    cliente.clear();
    setEstado({ tipo: "anonimo" });
  }, [cliente]);

  const valor = useMemo(
    () => ({ estado, usuario: estado.tipo === "logado" ? estado.usuario : null, entrar, sair }),
    [estado, entrar, sair],
  );
  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSessao() {
  const v = useContext(Contexto);
  if (!v) throw new Error("useSessao fora do ProvedorSessao");
  return v;
}

/** Usuário logado. Só use dentro das telas protegidas. */
export function useUsuario(): UsuarioDTO {
  const { usuario } = useSessao();
  if (!usuario) throw new Error("useUsuario sem sessão");
  return usuario;
}
