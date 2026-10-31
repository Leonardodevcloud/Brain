import type { StatusIntegracaoDTO } from "@cerebro/core/publico";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Copy, Upload } from "lucide-react";
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
  central_api: { nome: "API da Central", descricao: "O Argos chama as mesmas rotas das telas do BI e do BI Financeiro: o número bate com a tela." },
  codigo_central: { nome: "Regras do código", descricao: "Lê o código do BI e do Financeiro no GitHub e guarda as regras de cálculo no Cérebro." },
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

/** O texto que vai nas instruções de cada Projeto (pasta) do Claude. */
export function instrucoesDoProjeto(nome: string, foco: string) {
  const n = nome.trim() || "Geral";
  return [
    `Projeto: ${n}`,
    `Este projeto faz parte da Central Tutts (entregas rápidas de autopeças com motoboys).${foco.trim() ? ` Aqui cuidamos de: ${foco.trim()}` : ""}`,
    "",
    "Use sempre o conector \u201cCérebro Tutts\u201d nesta pasta:",
    "- Antes de responder sobre regras, processos, clientes ou decisões da Tutts, consulte o Cérebro (buscar_conhecimento) e cite os códigos (ex.: POL-002).",
    "- Números da operação vêm da Central, nunca de cabeça: use indicador_central primeiro (é o mesmo número da tela do BI) e consultar_central só quando não houver rota. Diga o período do dado.",
    `- Quando eu ensinar ou corrigir uma regra, fórmula, apelido, decisão ou processo, guarde no Cérebro (guardar_no_cerebro) com projeto "${n}" e me avise em uma frase.`,
    "- Combinados e próximos passos viram tarefas no Cérebro (criar_tarefa), com prazo quando eu disser.",
    "- Se o conector não estiver ligado nesta conversa, me avise para ligar: botão + › Conectores › Cérebro Tutts.",
  ].join("\n");
}

const MODELOS_PROJETO = [
  { nome: "Financeiro", foco: "margem por cliente, BI Financeiro, garantido, saques dos motoboys e cobrança." },
  { nome: "Operações", foco: "disponibilidade e escala dos motoboys, prazo (SLA), retornos e ocorrências das lojas." },
  { nome: "Comercial", foco: "clientes, propostas, precificação e acompanhamento de contratos." },
];

/** Passo a passo para ligar o Claude ao Cérebro e o texto pronto para cada Projeto (pasta). */
function ProjetosClaude() {
  const copiar = useCopiar();
  const [nome, setNome] = useState("Financeiro");
  const [foco, setFoco] = useState(MODELOS_PROJETO[0]!.foco);
  const texto = instrucoesDoProjeto(nome, foco);
  return (
    <div className={css.extra}>
      <span className="rotulo">Como ligar o Claude ao Cérebro (uma vez só)</span>
      <ol className={css.passos}>
        <li>
          Acima, gere um endereço (ex.: “Claude do Leonardo”) e copie. Um endereço serve para todos os seus Projetos do Claude.
        </li>
        <li>
          No claude.ai: <b>Personalizar</b> (Customize) › <b>Conectores</b> (Connectors) › <b>+ Adicionar</b> › <b>Adicionar conector personalizado</b>.
          Nome: <code>Cérebro Tutts</code>. URL: cole o endereço. Clique em <b>Continuar</b>, escolha <b>Sem login</b> (No sign in) e clique em <b>Adicionar</b>.
          <span className="suave"> Em plano Team/Enterprise, quem adiciona é o dono da conta, em Configurações da organização › Conectores; depois cada pessoa clica em Conectar.</span>
        </li>
        <li>
          Em cada conversa: botão <b>+</b> no canto de baixo da caixa de mensagem › <b>Conectores</b> › ligue <b>Cérebro Tutts</b>.
        </li>
        <li>
          Em cada Projeto (pasta) do Claude: abra o projeto › <b>Instruções</b> (Instructions) › cole o texto abaixo. Ele vale para todas as conversas da pasta.
        </li>
      </ol>

      <span className="rotulo">Texto para as instruções do Projeto</span>
      <div className={css.modelos} role="group" aria-label="Modelos de projeto">
        {MODELOS_PROJETO.map((m) => (
          <button
            key={m.nome}
            type="button"
            className={`botao botao-pequeno ${nome === m.nome ? "botao-primario" : ""}`}
            onClick={() => {
              setNome(m.nome);
              setFoco(m.foco);
            }}
          >
            {m.nome}
          </button>
        ))}
      </div>
      <div className={`${css.formLinha} ${css.camposProjeto}`}>
        <div className="campo" style={{ flex: "1 1 180px" }}>
          <label htmlFor="proj-nome">Nome do projeto (o mesmo da pasta no Claude)</label>
          <input id="proj-nome" className="entrada" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <div className="campo" style={{ flex: "3 1 320px" }}>
          <label htmlFor="proj-foco">Do que esse projeto cuida</label>
          <textarea id="proj-foco" className={`area-texto ${css.focoProjeto}`} rows={2} value={foco} onChange={(e) => setFoco(e.target.value)} />
        </div>
      </div>
      <textarea className={`area-texto ${css.textoProjeto}`} readOnly rows={11} value={texto} aria-label="Texto para as instruções do projeto" />
      <div>
        <button type="button" className="botao botao-primario botao-pequeno" onClick={() => copiar(texto, `Texto do projeto ${nome.trim() || "Geral"} copiado.`)}>
          <Copy size={14} aria-hidden="true" /> Copiar texto do projeto
        </button>
      </div>
      <p className="ajuda">
        O que o Claude guardar numa conversa entra em <b>Revisar</b> com o nome do projeto, e o Argos já passa a usar. Mesmo sem esse texto, o
        conector avisa o Claude de que ele está ligado à Central; o texto do projeto deixa isso mais firme e marca de qual pasta veio cada memória.
      </p>
    </div>
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

/**
 * Uma integração: texto | situação | ações, sempre nas mesmas colunas.
 * Com `detalhe`, o cartão abre e fecha ao clicar no texto (seta à direita do nome).
 */
function Linha({
  s,
  acao,
  children,
  detalhe,
  aberto = false,
  aoAlternar,
}: {
  s: StatusIntegracaoDTO;
  acao?: ReactNode;
  children?: ReactNode;
  detalhe?: ReactNode;
  aberto?: boolean;
  aoAlternar?: () => void;
}) {
  const texto = (
    <>
      <span className={css.nome}>
        {INFO[s.nome].nome}
        {detalhe !== undefined && <ChevronDown size={16} aria-hidden="true" className={`${css.seta} ${aberto ? css.setaAberta : ""}`} />}
      </span>
      <span className="suave">{INFO[s.nome].descricao}</span>
      <span className="pequeno suave">{s.detalhe}</span>
    </>
  );
  return (
    <li className={`${css.linha} ${aberto ? css.linhaAberta : ""}`}>
      <div className={css.cabecalhoLinha}>
        {detalhe !== undefined ? (
          <button type="button" className={`${css.textoLinha} ${css.textoBotao}`} aria-expanded={aberto} onClick={aoAlternar}>
            {texto}
          </button>
        ) : (
          <div className={css.textoLinha}>{texto}</div>
        )}
        <Estado s={s} />
        <div className={css.acoes}>{acao}</div>
      </div>
      {aberto && detalhe}
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
          <span className="rotulo">Endereço do conector (cole no Claude)</span>
          <div className={css.formLinha}>
            <code className={css.codigo}>{`${location.origin}/mcp/${novo}`}</code>
            <button type="button" className="botao botao-primario botao-pequeno" onClick={() => copiar(`${location.origin}/mcp/${novo}`, "Endereço copiado.")}>
              <Copy size={14} aria-hidden="true" /> Copiar
            </button>
          </div>
          <p className="ajuda">
            Aparece só agora: trate como senha (quem tiver o endereço lê o Cérebro). Siga o passo a passo abaixo para colar no Claude.
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

  const lerRegras = useMutation({
    mutationFn: () => api<{ agendado: boolean }>("/integracoes/codigo-central/ler", { metodo: "POST", corpo: {} }),
    onSuccess: () => {
      avisar("Leitura agendada. O cartão mostra o andamento; as regras aparecem na Biblioteca (tipo Sistema).");
      void qc.invalidateQueries({ queryKey: chaves.integracoes });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  const conectarGoogle = useMutation({
    mutationFn: () => api<{ url: string }>("/integracoes/google/conectar", { metodo: "POST" }),
    onSuccess: ({ url }) => location.assign(url),
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  const desconectarGoogle = useMutation({
    mutationFn: () => api<{ revogado: boolean }>("/integracoes/google", { metodo: "DELETE" }),
    onSuccess: (r) => {
      avisar(r.revogado ? "Google Agenda desconectado." : "Desconectado aqui. Se quiser, remova também o acesso em myaccount.google.com/permissions.");
      void qc.invalidateQueries();
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });
  const [confirmandoGoogle, setConfirmandoGoogle] = useState(false);
  const tokens = useTokens();
  const [confirmandoClaude, setConfirmandoClaude] = useState(false);
  // Desconectar o Claude = revogar todos os endereços do conector (o Claude perde o acesso na hora).
  const desconectarClaude = useMutation({
    mutationFn: async () => {
      for (const t of tokens.data ?? []) await api(`/conector/tokens/${t.id}`, { metodo: "DELETE" });
    },
    onSuccess: () => {
      avisar("Claude desconectado: os endereços foram revogados. Para voltar, gere um endereço novo.");
      void qc.invalidateQueries({ queryKey: chaves.tokens });
      void qc.invalidateQueries({ queryKey: chaves.integracoes });
    },
    onError: (e) => avisar(textoDoErro(e), "erro"),
  });

  // Enquanto o código está sendo lido (ou na fila), o cartão se atualiza sozinho.
  const lendoCodigo = Boolean(status.data?.some((s) => s.nome === "codigo_central" && /^(Lendo|Na fila)/.test(s.detalhe)));
  useEffect(() => {
    if (!lendoCodigo) return;
    const id = window.setInterval(() => void qc.invalidateQueries({ queryKey: chaves.integracoes }), 8000);
    return () => window.clearInterval(id);
  }, [lendoCodigo, qc]);

  const alternar = (nome: string) => setAberto((a) => (a === nome ? null : nome));
  const porNome = (nome: StatusIntegracaoDTO["nome"]) => status.data?.find((s) => s.nome === nome);
  const urlWebhook = `${location.origin}/api/webhooks/fathom`;

  const fontes = (["central", "central_api", "codigo_central", "claude", "fathom", "google", "email"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];
  const ia = (["deepseek", "embeddings", "voz", "fala"] as const).map(porNome).filter(Boolean) as StatusIntegracaoDTO[];

  return (
    <div className={`${pg.pagina} ${css.pagina}`}>
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
                        aberto={aberto === "claude"}
                        aoAlternar={() => alternar("claude")}
                        detalhe={
                          <>
                            <ConectorClaude />
                            <ProjetosClaude />
                          </>
                        }
                        acao={
                          (tokens.data?.length ?? 0) > 0 ? (
                            confirmandoClaude ? (
                              <span className={css.confirmar}>
                                <span className="pequeno suave">Revogar {tokens.data!.length === 1 ? "o endereço" : `os ${tokens.data!.length} endereços`}?</span>
                                <button type="button" className="botao botao-pequeno" onClick={() => setConfirmandoClaude(false)}>
                                  Cancelar
                                </button>
                                <button
                                  type="button"
                                  className="botao botao-pequeno botao-perigo"
                                  disabled={desconectarClaude.isPending}
                                  onClick={() => desconectarClaude.mutate(undefined, { onSettled: () => setConfirmandoClaude(false) })}
                                >
                                  Desconectar
                                </button>
                              </span>
                            ) : (
                              <button type="button" className="botao botao-pequeno" onClick={() => setConfirmandoClaude(true)}>
                                Desconectar
                              </button>
                            )
                          ) : (
                            <button type="button" className="botao botao-primario botao-pequeno" onClick={() => setAberto("claude")}>
                              Conectar
                            </button>
                          )
                        }
                      />
                    );
                  case "fathom":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        aberto={aberto === "fathom"}
                        aoAlternar={() => alternar("fathom")}
                        detalhe={
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
                              (whsec_…) para a variável FATHOM_WEBHOOK_SEGREDO no Railway. Para desconectar, apague o webhook na Fathom
                              e a variável no Railway.
                            </p>
                          </div>
                        }
                      />
                    );
                  case "google":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          admin &&
                          s.estado !== "desligado" &&
                          (confirmandoGoogle ? (
                            <span className={css.confirmar}>
                              <span className="pequeno suave">Desconectar a agenda?</span>
                              <button type="button" className="botao botao-pequeno" onClick={() => setConfirmandoGoogle(false)}>
                                Cancelar
                              </button>
                              <button
                                type="button"
                                className="botao botao-pequeno botao-perigo"
                                disabled={desconectarGoogle.isPending}
                                onClick={() => desconectarGoogle.mutate(undefined, { onSettled: () => setConfirmandoGoogle(false) })}
                              >
                                Desconectar
                              </button>
                            </span>
                          ) : (
                            <span className={css.confirmar}>
                              <button type="button" className="botao botao-pequeno" disabled={conectarGoogle.isPending} onClick={() => conectarGoogle.mutate()}>
                                {s.estado === "ativo" ? "Reconectar" : "Conectar"}
                              </button>
                              {s.detalhe.includes("onectad") && (
                                <button type="button" className="botao botao-pequeno" onClick={() => setConfirmandoGoogle(true)}>
                                  Desconectar
                                </button>
                              )}
                            </span>
                          ))
                        }
                      />
                    );
                  case "codigo_central":
                    return (
                      <Linha
                        key={s.nome}
                        s={s}
                        acao={
                          admin &&
                          s.estado !== "desligado" && (
                            <button type="button" className="botao botao-pequeno" disabled={lerRegras.isPending} onClick={() => lerRegras.mutate()}>
                              {lerRegras.isPending ? "Agendando…" : "Ler as regras agora"}
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
