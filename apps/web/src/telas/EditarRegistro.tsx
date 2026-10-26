import {
  AREAS,
  EMPRESAS,
  TIPOS_REGISTRO,
  type Area,
  type Confidencialidade,
  type Empresa,
  type RegistroDTO,
  type TipoRegistro,
} from "@cerebro/core/publico";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ErroApi, api } from "../api/cliente";
import { useAtualizarRegistro, useCriarRegistro, useRegistro } from "../api/consultas";
import { Esqueleto, MensagemErro, useAvisar } from "../componentes/comum";
import { Conteudo } from "../componentes/Conteudo";
import { useUsuario } from "../sessao/Sessao";
import { nomeArea, nomeTipo } from "../util/formato";
import pg from "./pagina.module.css";
import css from "./EditarRegistro.module.css";

/** Esqueleto de cada tipo: ninguém começa de uma página em branco. */
const MODELOS: Partial<Record<TipoRegistro, string>> = {
  pop: "## Objetivo\n\n\n## Quando usar\n\n\n## Passos\n\n1. \n2. \n3. \n\n## Exceções\n\n\n## Indicador de sucesso\n",
  decisao: "## Decisão\n\n\n## Contexto\n\n\n## Alternativas consideradas\n\n\n## Quem decidiu e quando\n",
  politica: "## Regra\n\n\n## A quem se aplica\n\n\n## Exceções\n\n\n## Consequências\n",
  ocorrencia: "## O que aconteceu\n\n\n## Impacto\n\n\n## Causa\n\n\n## O que fizemos\n\n\n## Como evitar\n",
  cliente: "## Resumo do cliente\n\n\n## SLA e combinados\n\n\n## Contatos\n\n\n## Pontos de atenção\n",
  sistema: "## Para que serve\n\n\n## Como acessar\n\n\n## Problemas comuns\n",
  indicador: "## Definição\n\n\n## Fórmula\n\n\n## Meta\n\n\n## Onde ver\n",
};

const NOME_EMPRESA: Record<Empresa, string> = { todas: "Todas", tutts: "Tutts", fiix: "Fiix", ig: "IG" };
const TIPOS_EDITAVEIS: TipoRegistro[] = TIPOS_REGISTRO.filter((t) => t !== "reuniao");
const SO_ADMIN: TipoRegistro[] = ["politica", "decisao"];

interface Formulario {
  tipo: TipoRegistro;
  titulo: string;
  conteudo: string;
  area: Area;
  empresa: Empresa;
  confidencialidade: Confidencialidade;
  clienteRef: string;
}

const CHAVE_RASCUNHO = "cerebro:rascunho-novo";
function lerRascunho(): Formulario | null {
  try {
    const s = localStorage.getItem(CHAVE_RASCUNHO);
    return s ? (JSON.parse(s) as Formulario) : null;
  } catch {
    return null;
  }
}
function gravarRascunho(f: Formulario | null) {
  try {
    if (f) localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(f));
    else localStorage.removeItem(CHAVE_RASCUNHO);
  } catch {
    /* armazenamento indisponível: segue sem rascunho local */
  }
}

function inicial(params: URLSearchParams, existente?: RegistroDTO): Formulario {
  if (existente) {
    return {
      tipo: existente.tipo,
      titulo: existente.titulo,
      conteudo: existente.conteudo,
      area: existente.area,
      empresa: existente.empresa,
      confidencialidade: existente.confidencialidade,
      clienteRef: existente.clienteRef ?? "",
    };
  }
  const tipoUrl = params.get("tipo") as TipoRegistro | null;
  const salvo = !tipoUrl && !params.get("titulo") ? lerRascunho() : null;
  if (salvo) return salvo;
  const tipo = tipoUrl && TIPOS_EDITAVEIS.includes(tipoUrl) ? tipoUrl : "pop";
  return {
    tipo,
    titulo: params.get("titulo") ?? "",
    conteudo: MODELOS[tipo] ?? "",
    area: "operacoes",
    empresa: "todas",
    confidencialidade: "interno",
    clienteRef: "",
  };
}

function Editor({ existente }: { existente?: RegistroDTO }) {
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const usuario = useUsuario();
  const navegar = useNavigate();
  const avisar = useAvisar();
  const criar = useCriarRegistro();
  const atualizar = useAtualizarRegistro(existente?.id ?? "");
  const [f, setF] = useState<Formulario>(() => inicial(params, existente));
  const [motivo, setMotivo] = useState("");
  const [publicar, setPublicar] = useState(true);
  const [aba, setAba] = useState<"escrever" | "visualizar">("escrever");
  const [tocados, setTocados] = useState<Record<string, boolean>>({});
  const [erroServidor, setErroServidor] = useState<ErroApi | null>(null);

  const novo = !existente;
  const podePublicar = usuario.papel === "admin" || !SO_ADMIN.includes(f.tipo);
  const substitui = params.get("substitui");

  // Guarda o que está sendo escrito para não perder ao trocar de tela.
  useEffect(() => {
    if (novo) gravarRascunho(f);
  }, [f, novo]);

  const problemas = useMemo(() => {
    const p: Record<string, string> = {};
    if (f.titulo.trim().length < 3) p.titulo = "Dê um título com pelo menos 3 letras.";
    const semModelo = f.conteudo.replace(MODELOS[f.tipo] ?? "", "").trim();
    if (!f.conteudo.trim() || (novo && !semModelo)) p.conteudo = "Escreva o conteúdo antes de salvar.";
    if (!novo && motivo.trim().length < 3) p.motivo = "Conte em poucas palavras o que mudou.";
    for (const d of erroServidor?.detalhes ?? []) p[d.campo] ??= d.mensagem;
    return p;
  }, [f, motivo, novo, erroServidor]);

  const mostrar = (campo: string) => (tocados[campo] ? problemas[campo] : undefined);
  const mudar = <K extends keyof Formulario>(campo: K, valor: Formulario[K]) => {
    setErroServidor(null);
    setF((atual) => {
      // Trocar o tipo troca o modelo, se a pessoa ainda não escreveu nada.
      if (campo === "tipo" && atual.conteudo.trim() === (MODELOS[atual.tipo] ?? "").trim()) {
        return { ...atual, tipo: valor as TipoRegistro, conteudo: MODELOS[valor as TipoRegistro] ?? "" };
      }
      return { ...atual, [campo]: valor };
    });
  };

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setTocados({ titulo: true, conteudo: true, motivo: true });
    if (Object.keys(problemas).length) return;
    try {
      const comum = {
        titulo: f.titulo.trim(),
        conteudo: f.conteudo.trim(),
        area: f.area,
        empresa: f.empresa,
        confidencialidade: f.confidencialidade,
        clienteRef: f.clienteRef.trim() || null,
      };
      const r = novo
        ? await criar.mutateAsync({
            ...comum,
            tipo: f.tipo,
            publicar: publicar && podePublicar,
            relacoes: substitui ? [{ destinoId: substitui, tipo: "substitui" }] : [],
          })
        : await atualizar.mutateAsync({ ...comum, motivo: motivo.trim() });
      if (novo) gravarRascunho(null);
      // Veio de "Sem resposta" em Revisar: a pergunta sai da lista, ligada ao registro novo.
      const lacuna = params.get("lacuna");
      if (novo && lacuna) {
        await api(`/lacunas/${lacuna}/resolver`, { metodo: "POST", corpo: { registroId: r.id } }).catch(() => undefined);
        void qc.invalidateQueries({ queryKey: ["lacunas"] });
      }
      avisar(novo ? (r.status === "vigente" ? `${r.codigo} publicado.` : `${r.codigo} salvo como rascunho.`) : `${r.codigo} atualizado para a v${r.versao}.`);
      navegar(`/registros/${r.codigo}`, { replace: true });
    } catch (erro) {
      if (erro instanceof ErroApi) setErroServidor(erro);
      else avisar("Não consegui salvar. Seu texto continua aqui.", "erro");
    }
  }

  const salvando = criar.isPending || atualizar.isPending;
  const rotuloSalvar = novo ? (publicar && podePublicar ? "Publicar" : "Salvar rascunho") : "Salvar nova versão";

  return (
    <form className={pg.pagina} onSubmit={salvar} noValidate>
      <Link to={existente ? `/registros/${existente.codigo}` : "/biblioteca"} className={pg.voltar}>
        <ArrowLeft size={14} aria-hidden="true" /> {existente ? existente.codigo : "Biblioteca"}
      </Link>
      <header className={pg.cabecalho}>
        <div className={pg.titulos}>
          <h1>{novo ? "Novo registro" : `Editar ${existente.codigo}`}</h1>
          {!novo && <p className="suave">A versão atual fica guardada no histórico.</p>}
        </div>
      </header>

      {erroServidor && !erroServidor.detalhes && (
        <div className="aviso aviso-erro" role="alert">
          {erroServidor.message}
        </div>
      )}

      <div className={pg.duasColunas}>
        <div className={css.principal}>
          <div className="campo">
            <label htmlFor="titulo">Título</label>
            <input
              id="titulo"
              className={`entrada ${css.titulo}`}
              value={f.titulo}
              onChange={(e) => mudar("titulo", e.target.value)}
              onBlur={() => setTocados((t) => ({ ...t, titulo: true }))}
              aria-invalid={Boolean(mostrar("titulo"))}
              aria-describedby={mostrar("titulo") ? "erro-titulo" : undefined}
              placeholder={f.tipo === "pop" ? "ex.: Troca de motoboy em rota" : undefined}
              autoFocus={novo}
            />
            {mostrar("titulo") && (
              <span id="erro-titulo" className="erro-campo">
                {mostrar("titulo")}
              </span>
            )}
          </div>

          <div className="campo">
            <div className={css.abas} role="tablist" aria-label="Conteúdo">
              <span className="rotulo" id="rotulo-conteudo">
                Conteúdo
              </span>
              <span style={{ flexGrow: 1 }} />
              {(["escrever", "visualizar"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  role="tab"
                  aria-selected={aba === a}
                  className={`${css.aba} ${aba === a ? css.abaAtiva : ""}`}
                  onClick={() => setAba(a)}
                >
                  {a === "escrever" ? "Escrever" : "Visualizar"}
                </button>
              ))}
            </div>
            {aba === "escrever" ? (
              <textarea
                className="area-texto"
                aria-labelledby="rotulo-conteudo"
                value={f.conteudo}
                onChange={(e) => mudar("conteudo", e.target.value)}
                onBlur={() => setTocados((t) => ({ ...t, conteudo: true }))}
                aria-invalid={Boolean(mostrar("conteudo"))}
                rows={18}
              />
            ) : (
              <div className={`cartao ${css.previa}`}>
                <Conteudo texto={f.conteudo || "_Nada escrito ainda._"} />
              </div>
            )}
            {mostrar("conteudo") ? (
              <span className="erro-campo">{mostrar("conteudo")}</span>
            ) : (
              <span className="ajuda">Markdown: ## para seções, 1. para passos, **negrito**.</span>
            )}
          </div>

          {!novo && (
            <div className="campo">
              <label htmlFor="motivo">O que mudou?</label>
              <input
                id="motivo"
                className="entrada"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                onBlur={() => setTocados((t) => ({ ...t, motivo: true }))}
                aria-invalid={Boolean(mostrar("motivo"))}
                placeholder="ex.: prazo de aviso à loja mudou para 8h30"
              />
              {mostrar("motivo") ? (
                <span className="erro-campo">{mostrar("motivo")}</span>
              ) : (
                <span className="ajuda">Aparece no histórico da versão.</span>
              )}
            </div>
          )}
        </div>

        <aside className={css.lateral}>
          {novo && (
            <div className="campo">
              <label htmlFor="tipo">Tipo</label>
              <select id="tipo" className="selecao" value={f.tipo} onChange={(e) => mudar("tipo", e.target.value as TipoRegistro)}>
                {TIPOS_EDITAVEIS.map((t) => (
                  <option key={t} value={t}>
                    {nomeTipo(t)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="campo">
            <label htmlFor="area">Área</label>
            <select id="area" className="selecao" value={f.area} onChange={(e) => mudar("area", e.target.value as Area)}>
              {AREAS.map((a) => (
                <option key={a} value={a}>
                  {nomeArea(a)}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="empresa">Empresa</label>
            <select id="empresa" className="selecao" value={f.empresa} onChange={(e) => mudar("empresa", e.target.value as Empresa)}>
              {EMPRESAS.map((x) => (
                <option key={x} value={x}>
                  {NOME_EMPRESA[x]}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="cliente">Cliente {f.tipo !== "cliente" && <span className="suave">(opcional)</span>}</label>
            <input id="cliente" className="entrada" value={f.clienteRef} onChange={(e) => mudar("clienteRef", e.target.value)} />
          </div>
          <label className={css.opcao}>
            <input
              type="checkbox"
              checked={f.confidencialidade === "restrito"}
              onChange={(e) => mudar("confidencialidade", e.target.checked ? "restrito" : "interno")}
            />
            <span>
              <span style={{ fontWeight: 500 }}>Restrito</span>
              <span className="ajuda" style={{ display: "block" }}>
                Não é enviado a IAs externas nem ao Claude.
              </span>
            </span>
          </label>
          {novo && (
            <label className={css.opcao}>
              <input type="checkbox" checked={publicar && podePublicar} disabled={!podePublicar} onChange={(e) => setPublicar(e.target.checked)} />
              <span>
                <span style={{ fontWeight: 500 }}>Publicar agora</span>
                <span className="ajuda" style={{ display: "block" }}>
                  {podePublicar ? "Desmarque para salvar como rascunho e revisar depois." : "Regras e decisões são aprovadas pelo administrador."}
                </span>
              </span>
            </label>
          )}

          <div className={css.salvar}>
            <button type="submit" className="botao botao-primario" disabled={salvando}>
              {salvando ? "Salvando…" : rotuloSalvar}
            </button>
            <Link to={existente ? `/registros/${existente.codigo}` : "/biblioteca"} className="botao botao-fantasma">
              Cancelar
            </Link>
          </div>
        </aside>
      </div>
    </form>
  );
}

export default function EditarRegistro() {
  const { id } = useParams();
  const consulta = useRegistro(id);
  if (!id) return <Editor />;
  if (consulta.isError) return <MensagemErro erro={consulta.error} aoTentar={() => void consulta.refetch()} />;
  if (!consulta.data) return <Esqueleto linhas={10} />;
  return <Editor key={consulta.data.id + consulta.data.versao} existente={consulta.data} />;
}
