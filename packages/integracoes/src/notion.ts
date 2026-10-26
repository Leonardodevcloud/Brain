import { requisitarJson } from "./util.js";

const API = "https://api.notion.com/v1";
// Versão estável que ainda aceita criar páginas com `parent.database_id`.
const VERSAO = "2022-06-28";

/** Como as colunas do banco de tarefas do Notion se chamam. Vem da tela de Integrações. */
export interface MapaTarefasNotion {
  databaseId: string;
  propTitulo: string;
  propPrazo?: string | null;
  propResponsavel?: string | null;
  /** Tipo da coluna de responsável: texto livre ou seleção. Pessoas do Notion exigem ids e ficam para depois. */
  tipoResponsavel?: "rich_text" | "select";
  propStatus?: string | null;
  tipoStatus?: "status" | "select";
  valorStatusInicial?: string | null;
  propOrigem?: string | null;
}

export interface NovaTarefa {
  titulo: string;
  responsavel?: string | null;
  prazo?: string | null;
  origemUrl?: string | null;
  descricao?: string | null;
}

export class ClienteNotion {
  constructor(private readonly token: string) {}

  private cabecalhos() {
    return {
      authorization: `Bearer ${this.token}`,
      "notion-version": VERSAO,
      "content-type": "application/json",
    };
  }

  /** Colunas do banco, para a tela de configuração sugerir o mapeamento. */
  async lerColunas(databaseId: string) {
    const dados = await requisitarJson<{ title?: { plain_text: string }[]; properties: Record<string, { type: string }> }>(
      "Notion",
      `${API}/databases/${databaseId}`,
      { headers: this.cabecalhos() },
    );
    return {
      nome: dados.title?.map((t) => t.plain_text).join("") ?? "",
      colunas: Object.entries(dados.properties).map(([nome, p]) => ({ nome, tipo: p.type })),
    };
  }

  async criarTarefa(mapa: MapaTarefasNotion, tarefa: NovaTarefa): Promise<{ id: string; url: string }> {
    const props: Record<string, unknown> = {
      [mapa.propTitulo]: { title: [{ text: { content: tarefa.titulo.slice(0, 2000) } }] },
    };
    if (mapa.propPrazo && tarefa.prazo) props[mapa.propPrazo] = { date: { start: tarefa.prazo } };
    if (mapa.propResponsavel && tarefa.responsavel) {
      props[mapa.propResponsavel] =
        mapa.tipoResponsavel === "select"
          ? { select: { name: tarefa.responsavel.slice(0, 100) } }
          : { rich_text: [{ text: { content: tarefa.responsavel.slice(0, 2000) } }] };
    }
    if (mapa.propStatus && mapa.valorStatusInicial) {
      props[mapa.propStatus] =
        mapa.tipoStatus === "select" ? { select: { name: mapa.valorStatusInicial } } : { status: { name: mapa.valorStatusInicial } };
    }
    if (mapa.propOrigem && tarefa.origemUrl) props[mapa.propOrigem] = { url: tarefa.origemUrl };

    const children = tarefa.descricao
      ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: tarefa.descricao.slice(0, 2000) } }] } }]
      : undefined;

    const pagina = await requisitarJson<{ id: string; url: string }>("Notion", `${API}/pages`, {
      method: "POST",
      headers: this.cabecalhos(),
      body: JSON.stringify({ parent: { database_id: mapa.databaseId }, properties: props, children }),
    });
    return { id: pagina.id, url: pagina.url };
  }

  /** Status atual de uma tarefa criada pelo cérebro (para o resumo semanal). */
  async lerStatus(paginaId: string, propStatus: string): Promise<string | null> {
    const pagina = await requisitarJson<{ properties: Record<string, { status?: { name: string }; select?: { name: string } }> }>(
      "Notion",
      `${API}/pages/${paginaId}`,
      { headers: this.cabecalhos() },
    );
    const p = pagina.properties[propStatus];
    return p?.status?.name ?? p?.select?.name ?? null;
  }
}
