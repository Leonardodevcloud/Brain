import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ErroApi, api } from "../api/cliente";
import { chaves, useUsuarios, type UsuarioEquipe } from "../api/consultas";
import { Esqueleto, MensagemErro, textoDoErro, useAvisar } from "../componentes/comum";
import { useSessao, useUsuario } from "../sessao/Sessao";
import { iniciais } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Conta.module.css";

function TrocarSenha() {
  const { sair } = useSessao();
  const avisar = useAvisar();
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const trocar = useMutation({
    mutationFn: () => api("/eu/senha", { metodo: "POST", corpo: { atual, nova } }),
    onSuccess: async () => {
      avisar("Senha trocada. Entre de novo com a nova senha.");
      await sair();
    },
    onError: (e) => setErro(e instanceof ErroApi ? e.message : "Não deu certo agora."),
  });
  const fraca = nova.length > 0 && (nova.length < 10 || !/[a-z]/i.test(nova) || !/\d/.test(nova));

  return (
    <form
      className={`cartao ${css.form}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setErro(null);
        trocar.mutate();
      }}
    >
      <div className="campo">
        <label htmlFor="senha-atual">Senha atual</label>
        <input id="senha-atual" type="password" className="entrada" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor="senha-nova">Nova senha</label>
        <input
          id="senha-nova"
          type="password"
          className="entrada"
          autoComplete="new-password"
          value={nova}
          onChange={(e) => setNova(e.target.value)}
          aria-invalid={fraca}
          aria-describedby="ajuda-senha"
        />
        <span id="ajuda-senha" className={fraca ? "erro-campo" : "ajuda"}>
          Pelo menos 10 caracteres, com letras e números.
        </span>
      </div>
      {erro && (
        <p className="erro-campo" role="alert">
          {erro}
        </p>
      )}
      <div>
        <button type="submit" className="botao botao-primario" disabled={!atual || !nova || fraca || trocar.isPending}>
          Trocar senha
        </button>
      </div>
      <p className="ajuda">Ao trocar, todas as suas sessões abertas são encerradas.</p>
    </form>
  );
}

/** Edição de uma pessoa da equipe (só o administrador vê). */
function EditarPessoa({ u, fechar }: { u: UsuarioEquipe; fechar: () => void }) {
  const qc = useQueryClient();
  const avisar = useAvisar();
  const eu = useUsuario();
  const { sair } = useSessao();
  const [nome, setNome] = useState(u.nome);
  const [email, setEmail] = useState(u.email);
  const [papel, setPapel] = useState(u.papel);
  const [ativo, setAtivo] = useState(u.ativo);
  const [senha, setSenha] = useState("");
  const souEu = eu.id === u.id;
  const fraca = senha.length > 0 && (senha.length < 10 || !/[a-z]/i.test(senha) || !/\d/.test(senha));

  const salvar = useMutation({
    mutationFn: () => {
      const corpo: Record<string, unknown> = {};
      if (nome.trim() !== u.nome) corpo.nome = nome.trim();
      if (email.trim().toLowerCase() !== u.email) corpo.email = email.trim();
      if (papel !== u.papel) corpo.papel = papel;
      if (ativo !== u.ativo) corpo.ativo = ativo;
      if (senha) corpo.novaSenha = senha;
      return api<{ sessoesEncerradas: boolean }>(`/usuarios/${u.id}`, { metodo: "PATCH", corpo });
    },
    onSuccess: async (r) => {
      void qc.invalidateQueries({ queryKey: chaves.usuarios });
      if (souEu && r.sessoesEncerradas) {
        avisar("Dados salvos. Entre de novo com o novo e-mail e a nova senha.");
        await sair();
        return;
      }
      avisar(souEu ? "Dados salvos." : `${nome.trim().split(" ")[0]} atualizado.${r.sessoesEncerradas ? " Ele precisa entrar de novo." : ""}`);
      if (souEu) window.setTimeout(() => window.location.reload(), 600); // atualiza o nome na tela
      fechar();
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  const mudou = nome.trim() !== u.nome || email.trim().toLowerCase() !== u.email || papel !== u.papel || ativo !== u.ativo || senha.length > 0;
  return (
    <form
      className={css.edicao}
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate();
      }}
    >
      <div className={css.grade}>
        <div className="campo">
          <label htmlFor={`e-nome-${u.id}`}>Nome</label>
          <input id={`e-nome-${u.id}`} className="entrada" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="off" />
        </div>
        <div className="campo">
          <label htmlFor={`e-email-${u.id}`}>E-mail de login</label>
          <input id={`e-email-${u.id}`} type="email" className="entrada" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </div>
        <div className="campo">
          <label htmlFor={`e-senha-${u.id}`}>Nova senha</label>
          <input
            id={`e-senha-${u.id}`}
            type="text"
            className="entrada mono"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete="new-password"
            placeholder="Deixe vazio para manter"
            aria-invalid={fraca}
          />
          <span className={fraca ? "erro-campo" : "ajuda"}>Pelo menos 10 caracteres, com letras e números.</span>
        </div>
        <div className="campo">
          <label htmlFor={`e-papel-${u.id}`}>Papel</label>
          <select id={`e-papel-${u.id}`} className="selecao" value={papel} onChange={(e) => setPapel(e.target.value as "membro" | "admin")}>
            <option value="membro">Supervisor</option>
            <option value="admin">Administrador</option>
          </select>
        </div>
      </div>
      {!souEu && (
        <label className={css.check}>
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Pode entrar no Second Brain
        </label>
      )}
      <p className="ajuda">
        {souEu
          ? "Você está editando a sua própria conta. Se mudar o e-mail ou a senha, vai precisar entrar de novo."
          : "Mudar o e-mail ou a senha encerra as sessões abertas dessa pessoa."}
      </p>
      <div className={css.acoesEdicao}>
        <button type="button" className="botao" onClick={fechar}>
          Cancelar
        </button>
        <button type="submit" className="botao botao-primario" disabled={!mudou || fraca || nome.trim().length < 2 || !email.includes("@") || salvar.isPending}>
          {salvar.isPending ? "Salvando…" : "Salvar"}
        </button>
      </div>
    </form>
  );
}

function Equipe() {
  const usuarios = useUsuarios();
  const qc = useQueryClient();
  const avisar = useAvisar();
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [papel, setPapel] = useState<"membro" | "admin">("membro");
  const [editando, setEditando] = useState<string | null>(null);
  const criar = useMutation({
    mutationFn: () => api("/usuarios", { metodo: "POST", corpo: { nome, email, senha, papel } }),
    onSuccess: () => {
      avisar(`${nome.split(" ")[0]} já pode entrar. Passe a senha por um canal seguro.`);
      setNome("");
      setEmail("");
      setSenha("");
      void qc.invalidateQueries({ queryKey: chaves.usuarios });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  return (
    <>
      {usuarios.isError ? (
        <MensagemErro erro={usuarios.error} />
      ) : !usuarios.data ? (
        <Esqueleto />
      ) : (
        <ul className={`lista cartao ${css.equipe}`}>
          {usuarios.data.map((u) => (
            <li key={u.id} className={css.linhaPessoa}>
              <div className={css.resumoPessoa} style={{ opacity: u.ativo ? 1 : 0.55 }}>
                <span aria-hidden="true" className={css.avatar}>
                  {iniciais(u.nome)}
                </span>
                <span className={css.pessoa}>
                  <span style={{ fontWeight: 500 }}>{u.nome}</span>
                  <span className="suave pequeno">{u.email}</span>
                </span>
                <span className="etiqueta">{!u.ativo ? "Sem acesso" : u.papel === "admin" ? "Administrador" : "Supervisor"}</span>
                {editando !== u.id && (
                  <button type="button" className="botao botao-pequeno" onClick={() => setEditando(u.id)} aria-label={`Editar ${u.nome}`}>
                    Editar
                  </button>
                )}
              </div>
              {editando === u.id && <EditarPessoa u={u} fechar={() => setEditando(null)} />}
            </li>
          ))}
        </ul>
      )}

      <form
        className={`cartao ${css.form}`}
        onSubmit={(e) => {
          e.preventDefault();
          criar.mutate();
        }}
      >
        <h3>Adicionar pessoa</h3>
        <div className={css.grade}>
          <div className="campo">
            <label htmlFor="u-nome">Nome</label>
            <input id="u-nome" className="entrada" value={nome} onChange={(e) => setNome(e.target.value)} autoComplete="off" />
          </div>
          <div className="campo">
            <label htmlFor="u-email">E-mail</label>
            <input id="u-email" type="email" className="entrada" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div className="campo">
            <label htmlFor="u-senha">Senha inicial</label>
            <input id="u-senha" type="text" className="entrada mono" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="off" />
            <span className="ajuda">A pessoa troca depois em Sua conta.</span>
          </div>
          <div className="campo">
            <label htmlFor="u-papel">Papel</label>
            <select id="u-papel" className="selecao" value={papel} onChange={(e) => setPapel(e.target.value as "membro" | "admin")}>
              <option value="membro">Supervisor</option>
              <option value="admin">Administrador</option>
            </select>
          </div>
        </div>
        <div>
          <button type="submit" className="botao" disabled={nome.trim().length < 2 || !email.includes("@") || senha.length < 10 || criar.isPending}>
            Adicionar à equipe
          </button>
        </div>
      </form>
    </>
  );
}

export default function Conta() {
  const usuario = useUsuario();
  const { sair } = useSessao();
  return (
    <div className={`${pg.pagina} ${pg.estreita}`}>
      <header className={pg.cabecalho}>
        <div className={pg.titulos}>
          <h1>Sua conta</h1>
          <p className="suave">
            {usuario.nome} · {usuario.email}
          </p>
        </div>
        <button type="button" className="botao" onClick={() => void sair()}>
          Sair
        </button>
        <Link to="/integracoes" className="botao">
          Integrações
        </Link>
      </header>
      <section className={pg.secao} aria-labelledby="t-senha">
        <h2 id="t-senha">Senha</h2>
        <TrocarSenha />
      </section>
      {usuario.papel === "admin" && (
        <section className={pg.secao} aria-labelledby="t-equipe">
          <h2 id="t-equipe">Equipe</h2>
          <Equipe />
        </section>
      )}
    </div>
  );
}
