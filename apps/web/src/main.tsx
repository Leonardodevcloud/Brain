import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./estilos/base.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErroApi } from "./api/cliente";
import { App } from "./App";
import { ProvedorAvisos } from "./componentes/comum";
import { ProvedorSessao } from "./sessao/Sessao";

const cliente = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // Erro de regra (4xx) não melhora tentando de novo.
      retry: (tentativas, erro) => !(erro instanceof ErroApi && erro.status >= 400 && erro.status < 500) && tentativas < 2,
    },
  },
});

createRoot(document.getElementById("raiz")!).render(
  <StrictMode>
    <QueryClientProvider client={cliente}>
      <ProvedorSessao>
        <ProvedorAvisos>
          <App />
        </ProvedorAvisos>
      </ProvedorSessao>
    </QueryClientProvider>
  </StrictMode>,
);
