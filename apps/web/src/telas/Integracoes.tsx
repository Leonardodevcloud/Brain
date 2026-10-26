import type { StatusIntegracaoDTO } from "@cerebro/core/publico";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/cliente";
import { chaves, useIntegracoes, useTokens, type MapaNotion } from "../api/consultas";
import { Esqueleto, MensagemErro, textoDoErro, useAvisar } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { relativo } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./Integracoes.module.css";

const ESTADO: Record<StatusIntegracaoDTO["estado"], { texto: string; cor: string }> = {
  ativo: { texto: "Ativo", cor: "var(--ok)" },
  incompleto: { texto: "Incompleto", cor: "var(--alerta)" },
  desligado: { texto: "Desligado", cor: "var(--texto-suave)" },
  erro: { texto: "Com erro", cor: "var(--erro)" },
};

const INFO: Record<StatusIntegracaoDTO["nome"], { nome: string; descricao: string }> = {
  claude: { nome: "Conector do Claude", descricao: "O Claude consulta o cérebro e salva rascunhos nas suas conversas." },
  fathom: { nome: "Fathom", descricao: "Grava o Meet e envia a transcrição; o cérebro gera a ata." },
  google: { nome: "Google Agenda", descricao: "Mostra as próximas reuniões no Início." },
  notion: { nome: "Notion", descricao: "Cria tarefas a partir das atas aprovadas." },
  email: { nome: "E-mail", descricao: "Lê a caixa dedicada e sugere rascunhos do que for conhecimento." },
  deepseek: { nome: "DeepSeek", descricao: "Respostas, atas e extração de conhecimento." },
  embeddings: { nome: "Gemini", descricao: "Busca por sentido, não só por palavra." },
  voz: { nome: "Argos (voz)", descricao: "Whisper pela Groq: transforma a sua fala em comando." },
};

function useCopiar() {
  const avisar = useAvisar();
  return (texto: string, aviso = "Copiado.") =>
    void navigator.clipboard.writeText(texto).then(
      () => avisar(aviso),
      () => avisar("Não consegui copiar. Selecione e copie manualmente.", "erro"),
    );
}

function Estado({ s }: { s: StatusIntegracaoDTO }) {
  const e = ESTADO[s.estado];
  return (
    <span className={css.estado}>
      <span aria-hidden="true" className="ponto" style={{ background: e.cor }} />
      {e.texto}
    </span>
  );
}

function Linha({ s, acao, children }: { s: StatusIntegracaoDTO; acao?: ReactNode; children?: ReactNode }) {
  return (
    <li className={css.linha}>
      <div className={css.cabecalhoLinha}>
        <div className={css.textoLinha}>
          <span className={css.nome}>{INFO[s.nome].nome}</span>
          <span className="suave">{INFO[s.nome].descricao}</span>
          <span className="pequeno suave">{s.detalhe}</span>
        </div>
        <Estado s={s} />
        {acao}
      </div>
      {children}
    </li>
  );
}

// ── Claude: tokens pessoais ──

function ConectorClaude() {
  const tokens = useTokens();
  const qc = useQueryClient();
  const copiar = useCopiar();
  const avisar = useAvisar();
  const [nome, setNome] = useState("Meu Claude");
  const [novo, setNovo] = useState<string | null>(null);
  const criar = useMutation({
    mutationFn: () => api<{ token: string }>("/conector/tokens", { metodo: "POST", corpo: { nome } }),
    onSuccess: (r) => {
      setNovo(r.token);
      void qc.invalidateQueries({ queryKey: chaves.tokens });
      void qc.invalidateQueries({ queryKey: chaves.integracoes });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });
  const revogar = useMutation({
    mutationFn: (id: string) => api(`/conector/tokens/${id}`, { metodo: "DELETE" }),
    onSuccess: () => {
      avisar("Endereço revogado. O Claude perde o acesso na próxima chamada.");
      void qc.invalidateQueries({ queryKey: chaves.tokens });
    },
  });

  return (
    <div className={css.extra}>
      {novo ? (
        <div className={css.segredo}>
          <span className="rotulo">1. Endereço do servidor</span>
          <div className={css.formLinha}>
            <code className={css.codigo}>{`${location.origin}/mcp`}</code>
            <button type="button" className="botao botao-pequeno" onClick={() => copiar(`${location.origin}/mcp`, "Endereço copiado.")}>
              <Copy size={14} aria-hidden="true" /> Copiar
            </button>
          </div>
          <span className="rotulo">2. Cabeçalho Authorization</span>
          <div className={css.formLinha}>
            <code className={css.codigo}>{`Bearer ${novo}`}</code>
            <button type="button" className="botao botao-primario botao-pequeno" onClick={() => copiar(`Bearer ${novo}`, "Cabeçalho copiado.")}>
              <Copy size={14} aria-hidden="true" /> Copiar
            </button>
          </div>
          <p className="ajuda">
            O token aparece só agora: trate como senha. No Claude: Personalizar › Conectores › + Adicionar › Adicionar conector
            personalizado. Cole o endereço, escolha “Sem login” e, em Cabeçalhos da requisição, crie <code>Authorization</code> com o valor
            acima. Se preferir sem cabeçalho, use o endereço com o token no fim: <code>{`${location.origin}/mcp/${novo}`}</code>
          </p>
          <div>
            <button type="button" className="botao botao-fantasma botao-pequeno" onClick={() => setNovo(null)}>
              Já configurei
            </button>
          </div>
        </div>
      ) : (
        <form
          className={css.formLinha}
          onSubmit={(e) => {
            e.preventDefault();
            criar.mutate();
          }}
        >
          <div className="campo" style={{ flexGrow: 1 }}>
            <label htmlFor="nome-token">Nome do acesso</label>
            <input id="nome-token" className="entrada" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <button type="submit" className="botao" disabled={nome.trim().length < 2 || criar.isPending}>
            Gerar endereço
          </button>
        </form>
      )}
      {tokens.data && tokens.data.length > 0 && (
        <ul className={`lista ${css.tokens}`}>
          {tokens.data.map((t) => (
            <li key={t.id}>
              <span>
                <span style={{ fontWeight: 500 }}>{t.nome}</span>{" "}
                <span className="mono suave pequeno">{t.prefixo}…</span>
              </span>
              <span className="suave pequeno">{t.ultimoUsoEm ? `usado ${relativo(t.ultimoUsoEm)}` : "nunca usado"}</span>
              <button type="button" className="botao botao-fantasma botao-pequeno botao-perigo" onClick={() => revogar.mutate(t.id)}>
                Revogar {t.nome}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Notion: mapear colunas ──

interface Colunas {
  nome: string;
  colunas: { nome: string; tipo: string }[];
}

function ConfigNotion({ aoSalvar }: { aoSalvar: () => void }) {
  const avisar = useAvisar();
  const [databaseId, setDatabaseId] = useState("");
  const [colunas, setColunas] = useState<Colunas | null>(null);
  const [mapa, setMapa] = useState<Partial<MapaNotion>>({});
  const ler = useMutation({
    mutationFn: (id: string) => api<Colunas>(`/integracoes/notion/colunas?databaseId=${encodeURIComponent(id)}`),
    onSuccess: (c) => {
      setColunas(c);
      const porTipo = (tipo: string) => c.colunas.find((x) => x.tipo === tipo)?.nome ?? null;
      setMapa({ propTitulo: porTipo("title") ?? "", propPrazo: porTipo("date"), propStatus: porTipo("status") ?? porTipo("select") });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });
  const salvar = useMutation({
    mutationFn: (m: MapaNotion) => api("/integracoes/notion/mapa", { metodo: "PUT", corpo: m }),
    onSuccess: () => {
      avisar("Notion configurado. As próximas atas aprovadas viram tarefas.");
      aoSalvar();
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  // Aceita o link inteiro do banco e extrai o id.
  const idLimpo = (databaseId.match(/[0-9a-f]{32}/i)?.[0] ?? databaseId).trim();
  const tipoDe = (nome?: string | null) => colunas?.colunas.find((c) => c.nome === nome)?.tipo;
  const opcoes = (tipos: string[]) => colunas?.colunas.filter((c) => tipos.includes(c.tipo)) ?? [];

  const selecao = (campo: keyof MapaNotion, rotulo: string, tipos: string[]) => (
    <div className="campo" key={campo}>
      <label htmlFor={`n-${campo}`}>{rotulo}</label>
      <select
        id={`n-${campo}`}
        className="selecao"
        value={(mapa[campo] as string | null | undefined) ?? ""}
        onChange={(e) => setMapa((m) => ({ ...m, [campo]: e.target.value || null }))}
      >
        <option value="">Não usar</option>
        {opcoes(tipos).map((c) => (
          <option key={c.nome} value={c.nome}>
            {c.nome}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className={css.extra}>
      <form
        className={css.formLinha}
        onSubmit={(e) => {
          e.preventDefault();
          ler.mutate(idLimpo);
        }}
      >
        <div className="campo" style={{ flexGrow: 1 }}>
          <label htmlFor="notion-db">Link do banco de tarefas</label>
          <input
            id="notion-db"
            className="entrada"
            value={databaseId}
            onChange={(e) => setDatabaseId(e.target.value)}
            placeholder="https://www.notion.so/…"
          />
          <span className="ajuda">No Notion, conecte a integração ao banco (••• › Conexões) antes de ler as colunas.</span>
        </div>
        <button type="submit" className="botao" disabled={idLimpo.length < 10 || ler.isPending}>
          {ler.isPending ? "Lendo…" : "Ler colunas"}
        </button>
      </form>

      {colunas && (
        <form
          className={css.mapa}
          onSubmit={(e) => {
            e.preventDefault();
            salvar.mutate({
              databaseId: idLimpo,
              propTitulo: mapa.propTitulo ?? "",
              propPrazo: mapa.propPrazo ?? null,
              propResponsavel: mapa.propResponsavel ?? null,
              tipoResponsavel: tipoDe(mapa.propResponsavel) === "select" ? "select" : "rich_text",
              propStatus: mapa.propStatus ?? null,
              tipoStatus: tipoDe(mapa.propStatus) === "select" ? "select" : "status",
              valorStatusInicial: mapa.valorStatusInicial ?? null,
              propOrigem: mapa.propOrigem ?? null,
            });
          }}
        >
          <p className="pequeno">
            Banco: <strong>{colunas.nome || "sem nome"}</strong>
          </p>
          <div className={css.gradeMapa}>
            {selecao("propTitulo", "Título da tarefa", ["title"])}
            {selecao("propPrazo", "Prazo", ["date"])}
            {selecao("propResponsavel", "Responsável", ["rich_text", "select"])}
            {selecao("propStatus", "Status", ["status", "select"])}
            {mapa.propStatus && (
              <div className="campo">
                <label htmlFor="n-status-inicial">Status de uma tarefa nova</label>
                <input
                  id="n-status-inicial"
                  className="entrada"
                  value={mapa.valorStatusInicial ?? ""}
                  onChange={(e) => setMapa((m) => ({ ...m, valorStatusInicial: e.target.value || null }))}
                  placeholder="ex.: Não iniciado"
                />
              </div>
            )}
            {selecao("propOrigem", "Link da ata", ["url"])}
          </div>
          <div>
            <button type="submit" className="botao botao-primario" disabled={!mapa.propTitulo || salvar.isPending}>
              Salvar configuração do Notion
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Importação do histórico do Claude ──

function ImportarClaude() {
  const avisar = useAvisar();
  const qc = useQueryClient();
  const entrada = useRef<HTMLInputElement>(null);
  const importar = useMutation({
    mutationFn: (arquivo: File) =>
      api<{ total: number; novas: number; jaVistas: number }>("/importacao/claude", { metodo: "POST", arquivo }),
    onSuccess: (r) => {
      avisar(
        r.novas
          ? `${r.novas} conversas novas em análise. Os rascunhos aparecem em Revisar.`
          : `Nenhuma conversa nova (${r.jaVistas} já vistas).`,
      );
      void qc.invalidateQueries({ queryKey: chaves.integracoes });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
    onSettled: () => {
      if (entrada.current) entrada.current.value = "";
    },
  });

  return (
    <div className={`cartao ${css.importar}`}>
      <div className={css.textoLinha}>
        <span className={css.nome}>Importar conversas exportadas</span>
        <span className="suave">
          No Claude, vá em Configurações › Privacidade › Exportar dados e envie aqui o .zip recebido por e-mail. Só conversas novas são
          analisadas; o que for conhecimento vira rascunho para revisar.
        </span>
      </div>
      <label className={`botao ${importar.isPending ? css.desativado : ""}`}>
        <Upload size={16} aria-hidden="true" />
        {importar.isPending ? "Enviando…" : "Enviar arquivo .zip"}
        <input
          ref={entrada}
          type="file"
          accept=".zip,application/zip"
          className="so-leitor"
          disabled={importar.isPending}
          onChange={(e) => {
            const arquivo = e.target.files?.[0];
            if (arquivo) importar.mutate(arquivo);
          }}
        />
      </label>
    </div>
  );
}

export default function Integracoes() {
  const usuario = useUsuario();
  const admin = usuario.papel === "admin";
  const status = useIntegracoes();
  const qc = useQueryClient();
  const avisar = useAvisar();
  const copiar = useCopiar();
  const [params, setParams] = useSearchParams();
  const [aberto, setAberto] = useState<string | null>(null);

  // Volta do Google com ?google=ok|erro.
  useEffect(() => {
    const g = params.get("google");
    if (!g) return;
    avisar(g === "ok" ? "Google Agenda conectado." : "Não deu para conectar o Google. Tente de novo.", g === "ok" ? "ok" : "erro");
    setParams({}, { replace: true });
  }, [params, setParams, avisar]);

  const conectarGoogle = useMutation({
    mutationFn: () => api<{ url: string }>("/integracoes/google/conectar", { metodo: "POST" }),
    onSuccess: ({ url }) => location.assign(url),
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  const alternar = (nome: string) => setAberto((a) => (a === nome ? null : nome));
  const porNome = (nome: StatusIntegracaoDTO["nome"]) => status.data?.find((s) => s.nome === nome);
  const urlWebhook = `${location.origin}/api/webhooks/fathom`;

  const fontes = (["claude", "fathom", "google", "notion", "email"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];
  const ia = (["deepseek", "embeddings", "voz"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];

  return (
    <div className={`${pg.pagina} ${pg.estreita}`}>
      <header className={pg.titulos}>
        <h1>Integrações</h1>
        <p className="suave">De onde o cérebro aprende e para onde ele envia.</p>
      </header>

      {status.isError ? (
        <MensagemErro erro={status.error} aoTentar={() => void status.refetch()} />
      ) : !status.data ? (
        <div className="cartao">
          <Esqueleto linhas={6} altura={20} />
        </div>
      ) : (
        <>
          <section className={pg.secao} aria-labelledby="t-fontes">
            <h2 id="t-fontes">Fontes e destinos</h2>
            <ul className={`lista cartao ${css.lista}`}>
              {fontes.map((s) => {
                switch (s.nome) {
                  case "claude":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          <button type="button" className="botao botao-pequeno" aria-expanded={aberto === "claude"} onClick={() => alternar("claude")}>
                            {aberto === "claude" ? "Fechar" : "Conectar"}
                          </button>
                        }
                      >
                        {aberto === "claude" && <ConectorClaude />}
                      </Linha>
                    );
                  case "fathom":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          <button type="button" className="botao botao-pequeno" aria-expanded={aberto === "fathom"} onClick={() => alternar("fathom")}>
                            {aberto === "fathom" ? "Fechar" : "Configurar"}
                          </button>
                        }
                      >
                        {aberto === "fathom" && (
                          <div className={css.extra}>
                            <span className="rotulo">Endereço do webhook</span>
                            <div className={css.formLinha}>
                              <code className={css.codigo}>{urlWebhook}</code>
                              <button type="button" className="botao botao-pequeno" onClick={() => copiar(urlWebhook, "Endereço copiado.")}>
                                <Copy size={14} aria-hidden="true" /> Copiar
                              </button>
                            </div>
                            <p className="ajuda">
                              Na Fathom: Settings › API Access › Add webhook, cole o endereço e marque “Transcript”. Copie o segredo
                              (whsec_…) para a variável FATHOM_WEBHOOK_SEGREDO no Railway.
                            </p>
                          </div>
                        )}
                      </Linha>
                    );
                  case "google":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          admin &&
                          s.estado !== "desligado" && (
                            <button type="button" className="botao botao-pequeno" disabled={conectarGoogle.isPending} onClick={() => conectarGoogle.mutate()}>
                              {s.estado === "ativo" ? "Reconectar" : "Conectar"}
                            </button>
                          )
                        }
                      />
                    );
                  case "notion":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          admin &&
                          s.estado !== "desligado" && (
                            <button type="button" className="botao botao-pequeno" aria-expanded={aberto === "notion"} onClick={() => alternar("notion")}>
                              {aberto === "notion" ? "Fechar" : s.estado === "ativo" ? "Trocar banco" : "Escolher banco"}
                            </button>
                          )
                        }
                      >
                        {aberto === "notion" && (
                          <ConfigNotion
                            aoSalvar={() => {
                              setAberto(null);
                              void qc.invalidateQueries({ queryKey: chaves.integracoes });
                            }}
                          />
                        )}
                      </Linha>
                    );
                  default:
                    return <Linha key={s.nome} s={s} />;
                }
              })}
            </ul>
          </section>

          <section className={pg.secao} aria-labelledby="t-ia">
            <h2 id="t-ia">Inteligência artificial</h2>
            <ul className={`lista cartao ${css.lista}`}>
              {ia.map((s) => (
                <Linha key={s.nome} s={s} />
              ))}
            </ul>
            <p className="ajuda">Dados pessoais (CPF, telefone, PIX, placas, e-mails) são mascarados antes de qualquer envio à IA.</p>
          </section>

          {admin && (
            <section className={pg.secao} aria-labelledby="t-historico">
              <h2 id="t-historico">Histórico do Claude</h2>
              <ImportarClaude />
            </section>
          )}
        </>
      )}
    </div>
  );
}
