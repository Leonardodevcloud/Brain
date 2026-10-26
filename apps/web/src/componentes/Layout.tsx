import { BookOpen, Home, Inbox, ListTodo, LogOut, Network, Plug, Search, UserRound } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useInicio, useRegistros } from "../api/consultas";
import { useResumoTarefas } from "../api/tarefas";
import { useSessao, useUsuario } from "../sessao/Sessao";
import { iniciais } from "../util/formato";
import { Argos } from "./argos/Argos";
import css from "./Layout.module.css";
import { Logo } from "./Logo";

function ContadorRevisar() {
  const rascunhos = useRegistros({ status: "rascunho", porPagina: 1 });
  const revisar = useRegistros({ status: "revisar", porPagina: 1 });
  const total = (rascunhos.data?.total ?? 0) + (revisar.data?.total ?? 0);
  if (!total) return null;
  return (
    <span className={css.contador} aria-label={`${total} itens para revisar`}>
      {total > 99 ? "99+" : total}
    </span>
  );
}

function ContadorTarefas() {
  const resumo = useResumoTarefas();
  const total = resumo.data?.minhas ?? 0;
  if (!total) return null;
  return (
    <span className={`${css.contador} ${resumo.data?.atrasadas ? css.contadorAlerta : ""}`} aria-label={`${total} tarefas suas abertas`}>
      {total > 99 ? "99+" : total}
    </span>
  );
}

const ITENS = [
  { para: "/", rotulo: "Início", Icone: Home, fim: true },
  { para: "/perguntar", rotulo: "Perguntar", Icone: Search },
  { para: "/biblioteca", rotulo: "Biblioteca", Icone: BookOpen },
  { para: "/tarefas", rotulo: "Tarefas", Icone: ListTodo, contador: "tarefas" },
  { para: "/mapa", rotulo: "Mapa", Icone: Network },
  { para: "/revisar", rotulo: "Revisar", Icone: Inbox, contador: "revisar" },
  { para: "/integracoes", rotulo: "Integrações", Icone: Plug, soDesktop: true },
];

export function Layout() {
  const usuario = useUsuario();
  const { sair } = useSessao();
  useInicio(); // pré-carrega o início enquanto a navegação aparece

  return (
    <div className={css.casca}>
      <a href="#conteudo" className={css.pular}>
        Pular para o conteúdo
      </a>
      <nav aria-label="Navegação principal" className={css.lateral}>
        <div className={css.marca}>
          <Logo tamanho={30} className={css.logo} />
          <div className={css.marcaTexto}>
            <span className={css.marcaNome}>Second Brain</span>
            <span className={css.marcaSub}>Tutts</span>
          </div>
        </div>

        <div className={css.itens}>
          {ITENS.map(({ para, rotulo, Icone, fim, contador, soDesktop }) => (
            <NavLink key={para} to={para} end={fim} className={({ isActive }) => `${css.item} ${isActive ? css.ativo : ""} ${soDesktop ? css.soDesktop : ""}`}>
              <Icone size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className={css.rotulo}>{rotulo}</span>
              {contador === "revisar" && <ContadorRevisar />}
              {contador === "tarefas" && <ContadorTarefas />}
            </NavLink>
          ))}
        </div>

        <div className={css.espaco} />
        <div className={css.perfil}>
          <NavLink to="/conta" className={css.perfilLink} title="Sua conta">
            <span aria-hidden="true" className={css.avatar}>
              {iniciais(usuario.nome)}
            </span>
            <span className={css.perfilTexto}>
              <span className={css.perfilNome}>{usuario.nome}</span>
              <span className={css.perfilPapel}>{usuario.papel === "admin" ? "Administrador" : "Supervisor"}</span>
            </span>
            <UserRound size={16} aria-hidden="true" className={css.soCelular} />
          </NavLink>
          <button type="button" className="botao botao-fantasma botao-icone" onClick={() => void sair()} title="Sair" aria-label="Sair">
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </nav>

      <main id="conteudo" className={css.principal} tabIndex={-1}>
        <Outlet />
      </main>
      <Argos />
    </div>
  );
}
