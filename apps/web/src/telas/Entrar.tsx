import { Eye, EyeOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { Logo } from "../componentes/Logo";
import { useSessao } from "../sessao/Sessao";
import css from "./Entrar.module.css";
import { RedeNeural } from "./entrar/RedeNeural";

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

  return (
    <main className={css.tela}>
      {/* Lado do formulário (claro, igual ao app). */}
      <section className={css.lado} aria-labelledby="t-entrar">
        <div className={css.caixa}>
          <span className={css.marca}>
            <Logo tamanho={32} />
            Second Brain
          </span>

          <div className={css.titulos}>
            <h1 id="t-entrar">{saudacao()}</h1>
            <p className="suave">Entre com o seu e-mail da Tutts.</p>
          </div>

          {estado.expirou && !erro && (
            <div className="aviso" role="status">
              Sua sessão terminou. Entre de novo para continuar de onde parou.
            </div>
          )}

          <form className={css.formulario} onSubmit={enviar} noValidate>
            <div className="campo">
              <label htmlFor="email">E-mail</label>
              <input
                id="email"
                className="entrada"
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
            <div className="campo">
              <label htmlFor="senha">Senha</label>
              <div className={css.senha}>
                <input
                  id="senha"
                  className="entrada"
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
              <p id="erro-entrar" className="erro-campo" role="alert">
                {erro}
              </p>
            )}
            <button type="submit" className={`botao botao-primario ${css.botao}`} disabled={enviando || !email || !senha}>
              {enviando ? "Entrando…" : "Entrar"}
            </button>
          </form>

          <p className={`suave pequeno ${css.rodape}`}>Sem acesso ou esqueceu a senha? Fale com o administrador.</p>
        </div>
        <p className={css.creditos}>© {new Date().getFullYear()} Central Tutts</p>
      </section>

      {/* Painel da constelação. */}
      <aside className={css.painel} aria-hidden="true">
        <RedeNeural className={css.rede} />
        <div className={css.frase}>
          <strong>O conhecimento da Tutts, conectado.</strong>
          <span>POPs, regras, dados da Central e o Argos, num só lugar.</span>
        </div>
      </aside>
    </main>
  );
}
