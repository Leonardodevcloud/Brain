import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Esqueleto } from "./componentes/comum";
import { Layout } from "./componentes/Layout";
import { useSessao } from "./sessao/Sessao";
import { Entrar } from "./telas/Entrar";
import { Inicio } from "./telas/Inicio";

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
                <Suspense fallback={<Carregando />}>
                  <Outlet />
                </Suspense>
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
