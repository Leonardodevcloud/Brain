import { ArrowRight, Database, Eye, EyeOff, Lock, Mail, Mic, Network } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { Logo } from "../componentes/Logo";
import { useSessao } from "../sessao/Sessao";
import css from "./Entrar.module.css";
import { RedeNeural } from "./entrar/RedeNeural";

const RECURSOS = [
  { Icone: Network, titulo: "Conhecimento conectado", texto: "POPs, regras, atas e documentos ligados num mapa vivo." },
  { Icone: Database, titulo: "Dados da operação", texto: "Disponibilidade, entregas e financeiro da Central em tempo real." },
  { Icone: Mic, titulo: "Argos por voz", texto: "Pergunte do seu jeito, por voz ou texto, e receba a análise." },
];

function saudacao() {
  const h = new Date().getHours();
  return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
}

export function Entrar() {
  const { estado, entrar } = useSessao();
  const local = useLocation();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [verSenha, setVerSenha] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [hora, setHora] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setHora(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  if (estado.tipo === "carregando") return null;
  if (estado.tipo === "logado") {
    const de = (local.state as { de?: string } | null)?.de;
    return <Navigate to={de && de !== "/entrar" ? de : "/"} replace />;
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await entrar(email.trim(), senha);
    } catch (falha) {
      setErro(falha instanceof ErroApi ? falha.message : "Não consegui entrar agora. Tente de novo.");
      setSenha("");
    } finally {
      setEnviando(false);
    }
  }

  const relogio = hora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const data = hora.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).replace(/\./g, "");

  return (
    <main className={css.tela}>
      <RedeNeural className={css.rede} />
      <div className={css.brilho} aria-hidden="true" />
      <div className={css.grade} aria-hidden="true" />

      <header className={css.topo}>
        <span className={css.marca}>
          <Logo tamanho={28} />
          <span>
            SECOND BRAIN <span className={css.barra}>//</span> TUTTS
          </span>
        </span>
        <span className={css.status}>
          <span className={css.ponto} aria-hidden="true" /> SISTEMA ONLINE
        </span>
      </header>

      <div className={css.conteudo}>
        <section className={css.heroi} aria-labelledby="t-heroi">
          <div className={css.logoGrande}>
            <span className={css.anel} aria-hidden="true" />
            <span className={`${css.anel} ${css.anel2}`} aria-hidden="true" />
            <Logo tamanho={84} />
          </div>
          <p className={css.rotuloMono}>INTELIGÊNCIA OPERACIONAL</p>
          <h1 id="t-heroi" className={css.manchete}>
            O cérebro da <span className={css.destaque}>operação Tutts</span>.
          </h1>
          <p className={css.subtitulo}>Tudo o que a empresa sabe, e tudo o que está acontecendo agora, num só lugar.</p>
          <ul className={css.recursos}>
            {RECURSOS.map(({ Icone, titulo, texto }) => (
              <li key={titulo}>
                <span className={css.iconeRecurso}>
                  <Icone size={16} aria-hidden="true" />
                </span>
                <span>
                  <strong>{titulo}</strong>
                  <span>{texto}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className={css.cartao} aria-labelledby="t-entrar">
          <span className={`${css.canto} ${css.cantoA}`} aria-hidden="true" />
          <span className={`${css.canto} ${css.cantoB}`} aria-hidden="true" />
          <span className={`${css.canto} ${css.cantoC}`} aria-hidden="true" />
          <span className={`${css.canto} ${css.cantoD}`} aria-hidden="true" />

          <div className={css.cabecalho}>
            <p className={css.rotuloMono}>
              {relogio} · <span className={css.data}>{data}</span>
            </p>
            <h2 id="t-entrar" className={css.titulo}>
              {saudacao()}.
            </h2>
            <p className={css.suave}>Acesse o Second Brain com o seu e-mail da Tutts.</p>
          </div>

          {estado.expirou && !erro && (
            <div className={css.aviso} role="status">
              Sua sessão terminou. Entre de novo para continuar de onde parou.
            </div>
          )}

          <form className={css.formulario} onSubmit={enviar} noValidate>
            <div className={css.campo}>
              <label htmlFor="email">E-mail</label>
              <div className={css.entradaCaixa}>
                <Mail size={16} aria-hidden="true" />
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  inputMode="email"
                  required
                  autoFocus
                  placeholder="voce@tutts.com.br"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            </div>
            <div className={css.campo}>
              <label htmlFor="senha">Senha</label>
              <div className={css.entradaCaixa} data-erro={erro ? "" : undefined}>
                <Lock size={16} aria-hidden="true" />
                <input
                  id="senha"
                  type={verSenha ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={senha}
                  aria-invalid={Boolean(erro)}
                  aria-describedby={erro ? "erro-entrar" : undefined}
                  onChange={(e) => {
                    setSenha(e.target.value);
                    setErro(null);
                  }}
                />
                <button
                  type="button"
                  className={css.olho}
                  onClick={() => setVerSenha((v) => !v)}
                  aria-label={verSenha ? "Esconder a senha" : "Mostrar a senha"}
                  aria-pressed={verSenha}
                  title={verSenha ? "Esconder a senha" : "Mostrar a senha"}
                >
                  {verSenha ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
                </button>
              </div>
            </div>
            {erro && (
              <p id="erro-entrar" className={css.erro} role="alert">
                {erro}
              </p>
            )}
            <button type="submit" className={css.botao} disabled={enviando || !email || !senha}>
              {enviando ? (
                <>
                  Conectando<span className={css.reticencias} aria-hidden="true" />
                </>
              ) : (
                <>
                  Entrar <ArrowRight size={17} aria-hidden="true" />
                </>
              )}
            </button>
          </form>

          <p className={css.rodape}>
            <Lock size={12} aria-hidden="true" /> Conexão criptografada · Sem acesso ou esqueceu a senha? Fale com o administrador.
          </p>
        </section>
      </div>

      <footer className={css.base}>
        <span>© {hora.getFullYear()} Central Tutts</span>
        <span className={css.baseDireita}>Argos · IA da Tutts</span>
      </footer>
    </main>
  );
}
