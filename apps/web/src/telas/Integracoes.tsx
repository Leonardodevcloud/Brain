import type { StatusIntegracaoDTO } from "@cerebro/core/publico";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Upload } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/cliente";
import { chaves, useIntegracoes, useTokens } from "../api/consultas";
import { Esqueleto, MensagemErro, textoDoErro, useAvisar } from "../componentes/comum";
import { useUsuario } from "../sessao/Sessao";
import { ouvirAmostra, recarregarVoz } from "../componentes/argos/fala";
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
  google: { nome: "Google Agenda", descricao: "Mostra as próximas reuniões, coloca tarefas na pauta e cria lembretes." },
  email: { nome: "E-mail", descricao: "Lê a caixa dedicada e sugere rascunhos do que for conhecimento." },
  deepseek: { nome: "DeepSeek", descricao: "Respostas, atas e extração de conhecimento." },
  embeddings: { nome: "Gemini", descricao: "Busca por sentido, não só por palavra." },
  central: { nome: "Banco da Central", descricao: "O Argos consulta disponibilidade, entregas, financeiro e o BI, só para leitura." },
  voz: { nome: "Argos (ouvido)", descricao: "Whisper pela Groq: transforma a sua fala em comando." },
  fala: { nome: "Argos (voz)", descricao: "Voz natural gerada no servidor: a mesma em qualquer aparelho." },
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

// ── Voz do Argos: uma escolha para a empresa toda ──

const DESCRICAO_VOZ: Record<string, string> = {
  marin: "Feminina, calorosa e natural (recomendada)",
  cedar: "Masculina, calma e natural (recomendada)",
  coral: "Feminina, animada",
  nova: "Feminina, jovem e clara",
  shimmer: "Feminina, suave",
  sage: "Feminina, serena",
  ballad: "Masculina, expressiva",
  ash: "Masculina, firme",
  verse: "Masculina, versátil",
  alloy: "Neutra",
  echo: "Masculina, grave",
  fable: "Masculina, narrador",
  onyx: "Masculina, bem grave",
};

function EscolherVoz() {
  const qc = useQueryClient();
  const avisar = useAvisar();
  const usuario = useUsuario();
  const [cfg, setCfg] = useState<{ voz: string; velocidade: number; vozes: string[] } | null>(null);
  const [ouvindo, setOuvindo] = useState(false);
  useEffect(() => {
    void api<{ voz: string; velocidade: number; vozes: string[] }>("/argos/voz").then(setCfg, () => setCfg(null));
  }, []);
  const salvar = useMutation({
    mutationFn: () => api("/argos/voz", { metodo: "PUT", corpo: { voz: cfg!.voz, velocidade: cfg!.velocidade } }),
    onSuccess: () => {
      recarregarVoz();
      void qc.invalidateQueries({ queryKey: chaves.integracoes });
      avisar("Voz salva. Vale para todos, em qualquer aparelho.");
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });
  if (!cfg) return <Esqueleto linhas={2} />;
  const primeiroNome = usuario.nome.split(" ")[0] ?? "";

  return (
    <div className={css.voz}>
      <div className={css.campoVoz}>
        <label htmlFor="voz-argos">Voz</label>
        <select id="voz-argos" value={cfg.voz} onChange={(e) => setCfg({ ...cfg, voz: e.target.value })}>
          {cfg.vozes.map((v) => (
            <option key={v} value={v}>
              {v.charAt(0).toUpperCase() + v.slice(1)} · {DESCRICAO_VOZ[v] ?? ""}
            </option>
          ))}
        </select>
      </div>
      <div className={css.campoVoz}>
        <label htmlFor="velocidade-argos">Ritmo · {cfg.velocidade.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}×</label>
        <input
          id="velocidade-argos"
          type="range"
          min={0.9}
          max={1.35}
          step={0.01}
          value={cfg.velocidade}
          onChange={(e) => setCfg({ ...cfg, velocidade: Number(e.target.value) })}
        />
      </div>
      <div className={css.acoesVoz}>
        <button
          type="button"
          className="botao"
          disabled={ouvindo}
          onClick={() => {
            setOuvindo(true);
            ouvirAmostra(cfg.voz, cfg.velocidade, primeiroNome)
              .catch((e) => avisar(textoDoErro(e), "erro"))
              .finally(() => setOuvindo(false));
          }}
        >
          {ouvindo ? "Gerando…" : "Ouvir"}
        </button>
        <button type="button" className="botao botao-primario" disabled={salvar.isPending} onClick={() => salvar.mutate()}>
          Usar esta voz
        </button>
      </div>
    </div>
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

  const fontes = (["central", "claude", "fathom", "google", "email"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];
  const ia = (["deepseek", "embeddings", "voz", "fala"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];

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
                <Linha key={s.nome} s={s}>
                  {s.nome === "fala" && s.estado === "ativo" && admin && <EscolherVoz />}
                </Linha>
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
