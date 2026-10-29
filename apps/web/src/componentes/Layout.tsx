import {
  BookOpen,
  CalendarDays,
  Ellipsis,
  Home,
  Inbox,
  ListTodo,
  LogOut,
  Mail,
  Network,
  Plug,
  Search,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { usePendentesEmail } from "../api/agenda";
import { useInicio, useRegistros } from "../api/consultas";
import { useResumoTarefas } from "../api/tarefas";
import { useSessao, useUsuario } from "../sessao/Sessao";
import { iniciais } from "../util/formato";
import { Argos } from "./argos/Argos";
import css from "./Layout.module.css";
import { Logo } from "./Logo";

type Contador = "revisar" | "tarefas" | "email";

function useContagens() {
  const rascunhos = useRegistros({ status: "rascunho", porPagina: 1 });
  const revisar = useRegistros({ status: "revisar", porPagina: 1 });
  const tarefas = useResumoTarefas();
  const email = usePendentesEmail();
  return {
    revisar: (rascunhos.data?.total ?? 0) + (revisar.data?.total ?? 0),
    tarefas: tarefas.data?.minhas ?? 0,
    tarefasAlerta: Boolean(tarefas.data?.atrasadas),
    email: email.data?.pendentes ?? 0,
  };
}

function Selo({ n, alerta, rotulo }: { n: number; alerta?: boolean; rotulo: string }) {
  if (!n) return null;
  return (
    <span className={`${css.contador} ${alerta ? css.contadorAlerta : ""}`} aria-label={`${n} ${rotulo}`}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

interface Item {
  para: string;
  rotulo: string;
  Icone: LucideIcon;
  fim?: boolean;
  contador?: Contador;
}

/** Ordem do menu lateral (computador). */
const LATERAL: Item[] = [
  { para: "/", rotulo: "Início", Icone: Home, fim: true },
  { para: "/perguntar", rotulo: "Perguntar", Icone: Search },
  { para: "/agenda", rotulo: "Agenda", Icone: CalendarDays },
  { para: "/tarefas", rotulo: "Tarefas", Icone: ListTodo, contador: "tarefas" },
  { para: "/email", rotulo: "E-mail", Icone: Mail, contador: "email" },
  { para: "/biblioteca", rotulo: "Biblioteca", Icone: BookOpen },
  { para: "/mapa", rotulo: "Mapa", Icone: Network },
  { para: "/revisar", rotulo: "Revisar", Icone: Inbox, contador: "revisar" },
  { para: "/integracoes", rotulo: "Integrações", Icone: Plug },
];

/** O que fica na gaveta "Mais" do celular. */
const GAVETA: Item[] = [
  { para: "/perguntar", rotulo: "Perguntar", Icone: Search },
  { para: "/email", rotulo: "E-mail", Icone: Mail, contador: "email" },
  { para: "/revisar", rotulo: "Revisar", Icone: Inbox, contador: "revisar" },
  { para: "/biblioteca", rotulo: "Biblioteca", Icone: BookOpen },
  { para: "/mapa", rotulo: "Mapa", Icone: Network },
  { para: "/integracoes", rotulo: "Integrações", Icone: Plug },
  { para: "/conta", rotulo: "Minha conta", Icone: UserRound },
];

const ROTULO_CONTADOR: Record<Contador, string> = {
  revisar: "itens para revisar",
  tarefas: "tarefas suas abertas",
  email: "e-mails esperando",
};

function Gaveta({ aberta, fechar, contagens }: { aberta: boolean; fechar: () => void; contagens: ReturnType<typeof useContagens> }) {
  const { sair } = useSessao();
  const usuario = useUsuario();
  const caixa = useRef<HTMLDivElement>(null);
  const local = useLocation();

  // Fecha ao navegar.
  const caminho = useRef(local.pathname);
  useEffect(() => {
    if (caminho.current !== local.pathname) fechar();
    caminho.current = local.pathname;
  }, [local.pathname, fechar]);

  useEffect(() => {
    if (!aberta) return;
    const anterior = document.activeElement as HTMLElement | null;
    caixa.current?.querySelector<HTMLElement>("a, button")?.focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar();
      if (e.key !== "Tab" || !caixa.current) return;
      const focaveis = [...caixa.current.querySelectorAll<HTMLElement>("a, button")];
      const primeiro = focaveis[0];
      const ultimo = focaveis[focaveis.length - 1];
      if (e.shiftKey && document.activeElement === primeiro) {
        e.preventDefault();
        ultimo?.focus();
      } else if (!e.shiftKey && document.activeElement === ultimo) {
        e.preventDefault();
        primeiro?.focus();
      }
    };
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("keydown", tecla);
      anterior?.focus();
    };
  }, [aberta, fechar]);

  if (!aberta) return null;
  return (
    <div className={css.veu} onClick={fechar}>
      <div ref={caixa} className={css.gaveta} role="dialog" aria-modal="true" aria-label="Mais opções" onClick={(e) => e.stopPropagation()}>
        <div className={css.alca} aria-hidden="true" />
        <div className={css.gavetaTopo}>
          <span className={css.avatarGrande} aria-hidden="true">
            {iniciais(usuario.nome)}
          </span>
          <span className={css.perfilTexto}>
            <span className={css.perfilNome}>{usuario.nome}</span>
            <span className={css.perfilPapel}>{usuario.papel === "admin" ? "Administrador" : "Supervisor"}</span>
          </span>
          <button type="button" className={css.fecharGaveta} onClick={fechar} aria-label="Fechar">
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Mais telas" className={css.grade}>
          {GAVETA.map(({ para, rotulo, Icone, contador }) => (
            <NavLink key={para} to={para} className={({ isActive }) => `${css.blocoGaveta} ${isActive ? css.blocoAtivo : ""}`}>
              <Icone size={22} strokeWidth={1.75} aria-hidden="true" />
              <span>{rotulo}</span>
              {contador && <Selo n={contagens[contador]} rotulo={ROTULO_CONTADOR[contador]} />}
            </NavLink>
          ))}
        </nav>
        <button type="button" className={css.sair} onClick={() => void sair()}>
          <LogOut size={18} aria-hidden="true" /> Sair da conta
        </button>
      </div>
    </div>
  );
}

const NA_GAVETA = GAVETA.map((g) => g.para);

export function Layout() {
  // A tela Perguntar ocupa a altura toda (é um app de conversa, não uma página que rola).
  const cheia = useLocation().pathname.startsWith("/perguntar");
  const usuario = useUsuario();
  const { sair } = useSessao();
  const local = useLocation();
  const [gaveta, setGaveta] = useState(false);
  const contagens = useContagens();
  useInicio(); // pré-carrega o início enquanto a navegação aparece

  const naGaveta = NA_GAVETA.some((p) => local.pathname.startsWith(p));
  const selo = (c?: Contador) =>
    c ? <Selo n={contagens[c]} alerta={c === "tarefas" && contagens.tarefasAlerta} rotulo={ROTULO_CONTADOR[c]} /> : null;
  const fecharGaveta = useRef(() => setGaveta(false)).current;

  return (
    <div className={css.casca}>
      <a href="#conteudo" className={css.pular}>
        Pular para o conteúdo
      </a>

      {/* Computador: menu lateral completo. */}
      <nav aria-label="Navegação principal" className={css.lateral}>
        <div className={css.marca}>
          <Logo tamanho={30} className={css.logo} />
          <div className={css.marcaTexto}>
            <span className={css.marcaNome}>Second Brain</span>
            <span className={css.marcaSub}>Tutts</span>
          </div>
        </div>

        <div className={css.itens}>
          {LATERAL.map(({ para, rotulo, Icone, fim, contador }) => (
            <NavLink key={para} to={para} end={fim} className={({ isActive }) => `${css.item} ${isActive ? css.ativo : ""}`}>
              <Icone size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className={css.rotulo}>{rotulo}</span>
              {selo(contador)}
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
          </NavLink>
          <button type="button" className="botao botao-fantasma botao-icone" onClick={() => void sair()} title="Sair" aria-label="Sair">
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </nav>

      {/* Celular: topo com a marca e o avatar (abre a gaveta, onde está o Sair). */}
      <header className={css.topoCelular}>
        <NavLink to="/" className={css.marcaCelular} aria-label="Início">
          <Logo tamanho={28} className={css.logo} />
          <span>Second Brain</span>
        </NavLink>
        <button type="button" className={css.avatarBotao} onClick={() => setGaveta(true)} aria-label="Sua conta e mais opções" aria-haspopup="dialog">
          {iniciais(usuario.nome)}
        </button>
      </header>

      <main id="conteudo" className={`${css.principal} ${cheia ? css.principalCheio : ""}`} tabIndex={-1}>
        <Outlet />
      </main>

      {/* Celular: barra de baixo com 4 abas e o Argos no centro. */}
      <nav aria-label="Navegação" className={css.barra}>
        <NavLink to="/" end className={({ isActive }) => `${css.aba} ${isActive ? css.abaAtiva : ""}`}>
          <Home size={22} strokeWidth={1.75} aria-hidden="true" />
          <span>Início</span>
        </NavLink>
        <NavLink to="/agenda" className={({ isActive }) => `${css.aba} ${isActive ? css.abaAtiva : ""}`}>
          <CalendarDays size={22} strokeWidth={1.75} aria-hidden="true" />
          <span>Agenda</span>
        </NavLink>
        <button type="button" className={`${css.aba} ${css.abaArgos}`} onClick={() => window.dispatchEvent(new Event("argos:ouvir"))} aria-label="Falar com o Argos">
          <span className={css.orbeArgos} aria-hidden="true">
            <span className={css.aura} />
            <span className={css.anelArgos} />
            <span className={css.esfera}>
              <span className={css.brilhoEsfera} />
            </span>
            <span className={css.onda} />
            <span className={`${css.onda} ${css.onda2}`} />
          </span>
          <span>Argos</span>
        </button>
        <NavLink to="/tarefas" className={({ isActive }) => `${css.aba} ${isActive ? css.abaAtiva : ""}`}>
          <ListTodo size={22} strokeWidth={1.75} aria-hidden="true" />
          <span>Tarefas</span>
          {selo("tarefas")}
        </NavLink>
        <button
          type="button"
          className={`${css.aba} ${naGaveta || gaveta ? css.abaAtiva : ""}`}
          onClick={() => setGaveta(true)}
          aria-haspopup="dialog"
          aria-expanded={gaveta}
        >
          <Ellipsis size={22} strokeWidth={1.75} aria-hidden="true" />
          <span>Mais</span>
          <Selo n={contagens.revisar + contagens.email} rotulo="pendências em outras telas" />
        </button>
      </nav>

      <Gaveta aberta={gaveta} fechar={fecharGaveta} contagens={contagens} />
      <Argos />
    </div>
  );
}
