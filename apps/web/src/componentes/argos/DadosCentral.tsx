import type { DadosCentralDTO } from "@cerebro/core/publico";
import { ChevronDown, Database } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import css from "./DadosCentral.module.css";

const Conteudo = lazy(() => import("../Conteudo").then((m) => ({ default: m.Conteudo })));

const MOEDA = /(valor|fatur|cobrado|pago|amount|receita|custo|preco|ticket|saldo)/i;
const PERCENTUAL = /(pct|percent|sla|taxa|margem)/i;
const LINHAS_VISIVEIS = 8;

const ROTULOS: Record<string, string> = { regiao: "Região", os: "OS", pct_em_loja: "% em loja", sla_pct: "SLA", margem_pct: "Margem" };

const rotular = (coluna: string) => {
  if (ROTULOS[coluna]) return ROTULOS[coluna];
  const t = coluna.replace(/_/g, " ").replace(/\bpct\b/i, "%").replace(/\bmin\b/i, "(min)").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Formata a célula conforme o nome da coluna: reais, %, datas, sim/não. */
function formatar(coluna: string, valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (typeof valor === "boolean") return valor ? "Sim" : "Não";
  const numero = typeof valor === "number" ? valor : typeof valor === "string" && /^-?\d+(\.\d+)?$/.test(valor) ? Number(valor) : null;
  if (numero !== null) {
    if (MOEDA.test(coluna)) return numero.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    if (PERCENTUAL.test(coluna)) return `${numero.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
    return numero.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}T/.test(valor)) {
    return new Date(valor).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Bahia" });
  }
  if (typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    return new Date(`${valor}T12:00:00Z`).toLocaleDateString("pt-BR", { timeZone: "UTC" });
  }
  // Códigos de status ("aguardando_aprovacao") viram texto legível.
  if (typeof valor === "string" && /status|situacao/i.test(coluna) && /^[a-z_]+$/.test(valor)) {
    const t = valor.replace(/_/g, " ").replace(/\bnao\b/g, "não").replace(/aprovacao/g, "aprovação");
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return typeof valor === "object" ? JSON.stringify(valor) : String(valor);
}

const numerica = (coluna: string, linhas: Record<string, unknown>[]) =>
  linhas.slice(0, 5).every((l) => l[coluna] === null || typeof l[coluna] === "number" || (typeof l[coluna] === "string" && /^-?\d+(\.\d+)?$/.test(l[coluna] as string)));

/** O que o Argos encontrou no banco da Central: números, tabela e como chegou neles. */
export function DadosCentral({ dados }: { dados: DadosCentralDTO }) {
  const [tudo, setTudo] = useState(false);
  const [bastidor, setBastidor] = useState(false);
  const linhas = tudo ? dados.linhas : dados.linhas.slice(0, LINHAS_VISIVEIS);

  return (
    <div className={css.dados}>
      {dados.destaques.length > 0 && (
        <dl className={css.destaques}>
          {dados.destaques.map((d) => (
            <div key={d.rotulo} className={css.destaque}>
              <dt>{d.rotulo}</dt>
              <dd>{d.valor}</dd>
            </div>
          ))}
        </dl>
      )}

      {dados.analise && (
        <div className={css.analise}>
          <Suspense fallback={null}>
            <Conteudo texto={dados.analise} />
          </Suspense>
        </div>
      )}

      {dados.linhas.length > 0 ? (
        <div className={css.tabelaCaixa}>
          <p className={css.tituloTabela}>{dados.titulo}</p>
          <div className={css.rolagem}>
            <table className={css.tabela}>
              <thead>
                <tr>
                  {dados.colunas.map((c) => (
                    <th key={c} scope="col" className={numerica(c, dados.linhas) ? css.num : undefined}>
                      {rotular(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={i}>
                    {dados.colunas.map((c) => (
                      <td key={c} className={numerica(c, dados.linhas) ? css.num : undefined}>
                        {formatar(c, l[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dados.linhas.length > LINHAS_VISIVEIS && (
            <button type="button" className={css.link} onClick={() => setTudo((v) => !v)}>
              {tudo ? "Mostrar menos" : `Mostrar as ${dados.linhas.length} linhas`}
              {dados.cortado && !tudo ? " (há mais no banco)" : ""}
            </button>
          )}
        </div>
      ) : (
        <p className={css.vazio}>Nenhum registro encontrado para isso.</p>
      )}

      <button type="button" className={css.link} onClick={() => setBastidor((v) => !v)} aria-expanded={bastidor}>
        <Database size={13} aria-hidden="true" /> Como cheguei nisso
        <ChevronDown size={13} aria-hidden="true" style={{ transform: bastidor ? "rotate(180deg)" : undefined }} />
      </button>
      {bastidor && (
        <div className={css.bastidor}>
          <p>
            {dados.origem === "pronta" ? "Consulta pronta e testada" : "Consulta escrita pela IA para esta pergunta"} · banco da Central, só leitura ·{" "}
            {dados.ms} ms
            {dados.tabelas.length > 0 && ` · tabelas: ${dados.tabelas.join(", ")}`}
          </p>
          {dados.explicacao && <p>{dados.explicacao}</p>}
          <pre className={css.sql}>
            <code>{dados.sql.replace(/\n\s+/g, "\n  ")}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
