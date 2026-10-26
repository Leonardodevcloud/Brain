import type { EmailDTO } from "@cerebro/core/publico";
import { ArrowRight, FilePlus2, ListPlus, Mail, RotateCcw, Sparkles, X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { useAcaoEmail, useEmails, type FiltroEmail } from "../api/agenda";
import { Esqueleto, MensagemErro, textoDoErro, useAvisar } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { relativo } from "../util/formato";
import css from "./Email.module.css";

const FILTROS: { id: FiltroEmail; rotulo: string }[] = [
  { id: "todos", rotulo: "Todos" },
  { id: "pendentes", rotulo: "Pendentes" },
  { id: "registro", rotulo: "Viraram registro" },
  { id: "ignorados", rotulo: "Ignorados" },
];

/** "Fulano <fulano@x.com>" → "Fulano". */
const nomeDe = (remetente: string) => remetente.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || remetente;

function Situacao({ e }: { e: EmailDTO }) {
  switch (e.situacao) {
    case "analisando":
      return (
        <span className={`${css.selo} ${css.seloRoxo}`}>
          <Sparkles size={12} aria-hidden="true" /> A IA está lendo
        </span>
      );
    case "registro":
      return e.registro ? (
        <Link to={e.registro.status === "rascunho" ? `/revisar/${e.registro.id}` : `/registros/${e.registro.codigo}`} className={`${css.selo} ${css.seloVerde}`}>
          {e.registro.status === "rascunho" ? `Rascunho ${e.registro.codigo} para revisar` : `Virou ${e.registro.codigo}`}
        </Link>
      ) : (
        <span className={`${css.selo} ${css.seloVerde}`}>Virou registro</span>
      );
    case "tarefa":
      return e.tarefa ? (
        <Link to={`/tarefas?abrir=${e.tarefa.codigo}`} className={`${css.selo} ${css.seloAmbar}`}>
          Virou {e.tarefa.codigo}
        </Link>
      ) : null;
    case "irrelevante":
      return <span className={`${css.selo} ${css.seloCinza}`}>A IA não viu conhecimento aqui</span>;
    case "ignorado":
      return <span className={`${css.selo} ${css.seloCinza}`}>Ignorado</span>;
    default:
      return null;
  }
}

function CartaoEmail({ e }: { e: EmailDTO }) {
  const acao = useAcaoEmail();
  const avisar = useAvisar();
  const fazer = (tipo: "ignorar" | "tarefa" | "registro", desfazer = false) =>
    acao.mutate(
      { id: e.id, acao: tipo, desfazer },
      {
        onSuccess: (r) =>
          avisar(
            tipo === "tarefa"
              ? `Tarefa ${r.tarefa?.codigo ?? ""} criada.`
              : tipo === "registro"
                ? `Rascunho ${r.registro?.codigo ?? ""} criado para revisar.`
                : desfazer
                  ? "E-mail de volta à caixa."
                  : "E-mail ignorado.",
          ),
        onError: (erro) => avisar(textoDoErro(erro), "erro"),
      },
    );

  const apagado = e.situacao === "ignorado" || e.situacao === "irrelevante";
  const rascunho = e.situacao === "registro" && e.registro?.status === "rascunho";
  return (
    <li className={`${css.email} ${e.pendente ? css.pendente : ""} ${apagado ? css.apagado : ""}`}>
      <div className={css.linha}>
        <span className={css.remetente}>{nomeDe(e.remetente)}</span>
        <time className={css.quando} dateTime={e.recebidoEm}>
          {relativo(e.recebidoEm)}
        </time>
      </div>
      <span className={css.assunto}>{e.assunto}</span>
      {e.trecho && <p className={css.trecho}>{e.trecho}</p>}
      <Situacao e={e} />
      <div className={css.acoes}>
        {rascunho && e.registro && (
          <Link to={`/revisar/${e.registro.id}`} className="botao botao-primario botao-pequeno">
            Revisar rascunho <ArrowRight size={14} aria-hidden="true" />
          </Link>
        )}
        {!e.tarefa && e.situacao !== "ignorado" && (
          <button type="button" className={`botao botao-pequeno ${!rascunho ? "botao-primario" : ""}`} onClick={() => fazer("tarefa")} disabled={acao.isPending}>
            <ListPlus size={14} aria-hidden="true" /> Criar tarefa
          </button>
        )}
        {!e.registro && e.situacao !== "ignorado" && e.situacao !== "analisando" && (
          <button type="button" className="botao botao-pequeno" onClick={() => fazer("registro")} disabled={acao.isPending}>
            <FilePlus2 size={14} aria-hidden="true" /> Virar registro
          </button>
        )}
        {e.situacao === "ignorado" ? (
          <button type="button" className="botao botao-pequeno" onClick={() => fazer("ignorar", true)} disabled={acao.isPending}>
            <RotateCcw size={14} aria-hidden="true" /> Desfazer
          </button>
        ) : (
          e.pendente &&
          !rascunho && (
            <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => fazer("ignorar")} disabled={acao.isPending}>
              <X size={14} aria-hidden="true" /> Ignorar
            </button>
          )
        )}
      </div>
    </li>
  );
}

export default function Email() {
  const [params, setParams] = useSearchParams();
  const filtro = (FILTROS.find((f) => f.id === params.get("filtro"))?.id ?? "todos") as FiltroEmail;
  const consulta = useEmails(filtro);
  const usuario = useUsuario();
  const d = consulta.data;

  return (
    <div className={css.pagina}>
      <header className={css.topo}>
        <h1>E-mail</h1>
        <p className="suave">
          {d?.caixa ? (
            <>
              Caixa <strong className={css.caixa}>{d.caixa}</strong>
              {d.ultimaLeituraEm ? ` · lida ${relativo(d.ultimaLeituraEm)}` : ""}
            </>
          ) : (
            "Os e-mails que chegam na caixa do Cérebro aparecem aqui, já lidos pela IA."
          )}
        </p>
      </header>

      <div className={css.filtros} role="tablist" aria-label="Filtrar e-mails">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filtro === f.id}
            className={`${css.filtro} ${filtro === f.id ? css.filtroAtivo : ""}`}
            onClick={() => setParams(f.id === "todos" ? {} : { filtro: f.id }, { replace: true })}
          >
            {f.rotulo}
            {f.id === "pendentes" && d && d.pendentes > 0 && <span className={css.qtd}>{d.pendentes}</span>}
          </button>
        ))}
      </div>

      {consulta.isError ? (
        <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />
      ) : !d ? (
        <Esqueleto linhas={5} altura={64} />
      ) : d.emails.length ? (
        <ul className={`lista ${css.lista}`}>
          {d.emails.map((e) => (
            <CartaoEmail key={e.id} e={e} />
          ))}
        </ul>
      ) : (
        <div className={css.vazio}>
          <Mail size={24} aria-hidden="true" />
          {!d.caixa ? (
            <>
              <p style={{ fontWeight: 600 }}>A caixa de e-mail ainda não está ligada.</p>
              <p className="suave pequeno">
                {usuario.papel === "admin" ? (
                  <>
                    Defina IMAP_HOST, IMAP_USUARIO e IMAP_SENHA no Railway. Veja em <Link to="/integracoes">Integrações</Link>.
                  </>
                ) : (
                  "Peça ao administrador para ligar a caixa dedicada do Cérebro."
                )}
              </p>
            </>
          ) : (
            <p className="suave">{filtro === "todos" ? "Nenhum e-mail chegou ainda." : "Nada neste filtro."}</p>
          )}
        </div>
      )}
    </div>
  );
}
