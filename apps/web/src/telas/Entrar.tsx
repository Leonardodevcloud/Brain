import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { ErroApi } from "../api/cliente";
import { useSessao } from "../sessao/Sessao";
import css from "./Entrar.module.css";

export function Entrar() {
  const { estado, entrar } = useSessao();
  const local = useLocation();
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
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
      <div className={css.caixa}>
        <div aria-hidden="true" className={css.logo}>
          <div />
        </div>
        <div className={css.titulos}>
          <h1 className={css.titulo}>Entrar no Cérebro</h1>
          <p className="suave">O conhecimento da Central Tutts, num só lugar.</p>
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor="senha">Senha</label>
            <input
              id="senha"
              className="entrada"
              type="password"
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

        <p className={`suave pequeno ${css.rodape}`}>Sem acesso ou esqueceu a senha? Fale com o administrador do Cérebro.</p>
      </div>
    </main>
  );
}
