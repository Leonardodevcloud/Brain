import { Component, lazy as lazyReact, Suspense, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Esqueleto } from "./componentes/comum";
import { Layout } from "./componentes/Layout";
import { useSessao } from "./sessao/Sessao";
import { Entrar } from "./telas/Entrar";
import { Inicio } from "./telas/Inicio";

/**
 * Carrega a tela sob demanda. Se o arquivo não existir mais (houve deploy com a aba aberta),
 * recarrega a página uma vez para pegar a versão nova, em vez de ficar em branco.
 */
const CHAVE_RECARGA = "cerebro:recarregou-versao";
function lazy<T extends ComponentType<object>>(importar: () => Promise<{ default: T }>) {
  return lazyReact(() =>
    importar().then(
      (m) => {
        try {
          sessionStorage.removeItem(CHAVE_RECARGA);
        } catch {
          /* sem armazenamento */
        }
        return m;
      },
      (erro: unknown) => {
        let ja = false;
        try {
          ja = sessionStorage.getItem(CHAVE_RECARGA) === "1";
          sessionStorage.setItem(CHAVE_RECARGA, "1");
        } catch {
          /* sem armazenamento: tenta recarregar mesmo assim */
        }
        if (!ja) {
          window.location.reload();
          return new Promise<never>(() => {});
        }
        throw erro;
      },
    ),
  );
}

/** Se uma tela quebrar, mostra um aviso com saída em vez de uma página em branco. */
class LimiteDeErro extends Component<{ children: ReactNode; chave: string }, { erro: Error | null }> {
  override state = { erro: null as Error | null };
  static getDerivedStateFromError(erro: Error) {
    return { erro };
  }
  override componentDidCatch(erro: Error) {
    console.error("[Second Brain] a tela quebrou", erro);
  }
  override componentDidUpdate(anterior: { chave: string }) {
    if (anterior.chave !== this.props.chave && this.state.erro) this.setState({ erro: null });
  }
  override render() {
    if (!this.state.erro) return this.props.children;
    return (
      <div className="cartao" style={{ maxWidth: 520, margin: "48px auto", display: "flex", flexDirection: "column", gap: 12 }} role="alert">
        <strong>Esta tela não carregou.</strong>
        <p className="suave">Pode ser uma atualização do sistema. Recarregar costuma resolver.</p>
        <p className="suave pequeno mono">{this.state.erro.message.slice(0, 200)}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="botao botao-primario" onClick={() => window.location.reload()}>
            Recarregar
          </button>
          <a href="/" className="botao">
            Ir para o início
          </a>
        </div>
      </div>
    );
  }
}

function ComLimite({ children }: { children: ReactNode }) {
  const local = useLocation();
  return <LimiteDeErro chave={local.pathname}>{children}</LimiteDeErro>;
}

// Telas menos usadas carregam sob demanda.
const Perguntar = lazy(() => import("./telas/Perguntar"));
const Biblioteca = lazy(() => import("./telas/Biblioteca"));
const Registro = lazy(() => import("./telas/Registro"));
const EditarRegistro = lazy(() => import("./telas/EditarRegistro"));
const Revisar = lazy(() => import("./telas/Revisar"));
const Integracoes = lazy(() => import("./telas/Integracoes"));
const Mapa = lazy(() => import("./telas/mapa/Mapa"));
const Tarefas = lazy(() => import("./telas/Tarefas"));
const Conta = lazy(() => import("./telas/Conta"));
const Agenda = lazy(() => import("./telas/Agenda"));
const Email = lazy(() => import("./telas/Email"));

function Protegida() {
  const { estado } = useSessao();
  const local = useLocation();
  if (estado.tipo === "carregando") return null;
  if (estado.tipo === "anonimo") return <Navigate to="/entrar" replace state={{ de: local.pathname + local.search }} />;
  return <Outlet />;
}

function Carregando() {
  return (
    <div style={{ maxWidth: 1120, margin: "0 auto" }}>
      <Esqueleto linhas={6} />
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/entrar" element={<Entrar />} />
        <Route element={<Protegida />}>
          <Route element={<Layout />}>
            <Route
              element={
                <ComLimite>
                  <Suspense fallback={<Carregando />}>
                    <Outlet />
                  </Suspense>
                </ComLimite>
              }
            >
              <Route index element={<Inicio />} />
              <Route path="perguntar" element={<Perguntar />} />
              <Route path="biblioteca" element={<Biblioteca />} />
              <Route path="registros/novo" element={<EditarRegistro />} />
              <Route path="registros/:id" element={<Registro />} />
              <Route path="registros/:id/editar" element={<EditarRegistro />} />
              <Route path="revisar" element={<Revisar />} />
              <Route path="revisar/:id" element={<Revisar />} />
              <Route path="tarefas" element={<Tarefas />} />
              <Route path="agenda" element={<Agenda />} />
              <Route path="email" element={<Email />} />
              <Route path="mapa" element={<Mapa />} />
              <Route path="integracoes" element={<Integracoes />} />
              <Route path="conta" element={<Conta />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
