import { AREAS, NOME_AREA, type Area } from "@cerebro/core/publico";
import { CheckCircle2, FileText, Upload, X, XCircle } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useEnviarDocumento } from "../api/tarefas";
import { useUsuario } from "../sessao/Sessao";
import { textoDoErro } from "./comum";
import css from "./EnviarDocumentos.module.css";

const ACEITOS = ".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv";
const LIMITE = 25 * 1024 * 1024;

interface Item {
  arquivo: File;
  estado: "fila" | "enviando" | "ok" | "erro";
  mensagem?: string;
  codigo?: string;
}

/** Envio de documentos (vários de uma vez): o texto de cada um vira conhecimento do Cérebro. */
export function EnviarDocumentos({ aoFechar }: { aoFechar: () => void }) {
  const eu = useUsuario();
  const enviar = useEnviarDocumento();
  const [area, setArea] = useState<Area>("operacoes");
  const [acesso, setAcesso] = useState<"interno" | "restrito">("interno");
  const [itens, setItens] = useState<Item[]>([]);
  const [sobre, setSobre] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const campo = useRef<HTMLInputElement>(null);

  function adicionar(lista: FileList | null) {
    if (!lista) return;
    const novos = [...lista].map<Item>((arquivo) =>
      arquivo.size > LIMITE
        ? { arquivo, estado: "erro", mensagem: "Passa de 25 MB." }
        : !ACEITOS.split(",").some((ext) => arquivo.name.toLowerCase().endsWith(ext))
          ? { arquivo, estado: "erro", mensagem: "Formato não aceito." }
          : { arquivo, estado: "fila" },
    );
    setItens((atual) => [...atual.filter((i) => i.estado !== "fila" || !novos.some((n) => n.arquivo.name === i.arquivo.name)), ...novos]);
  }

  async function enviarTodos() {
    setEnviando(true);
    // Um de cada vez: o servidor lê o texto de cada arquivo.
    for (let i = 0; i < itens.length; i++) {
      if (itens[i]!.estado !== "fila") continue;
      setItens((a) => a.map((x, j) => (j === i ? { ...x, estado: "enviando" } : x)));
      try {
        const r = await enviar.mutateAsync({ arquivo: itens[i]!.arquivo, area, confidencialidade: acesso });
        setItens((a) => a.map((x, j) => (j === i ? { ...x, estado: "ok", codigo: r.codigo, mensagem: r.status === "rascunho" ? "Enviado para aprovação" : "Já vale no Cérebro" } : x)));
      } catch (erro) {
        setItens((a) => a.map((x, j) => (j === i ? { ...x, estado: "erro", mensagem: textoDoErro(erro) } : x)));
      }
    }
    setEnviando(false);
  }

  const naFila = itens.filter((i) => i.estado === "fila").length;

  return (
    <section className={`cartao ${css.caixa}`} aria-labelledby="t-enviar">
      <div className={css.topo}>
        <h2 id="t-enviar">Enviar documentos</h2>
        <button type="button" className="botao botao-fantasma botao-icone" onClick={aoFechar} aria-label="Fechar">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="suave pequeno">
        Manuais, contratos, tabelas, apresentações: o texto de cada arquivo vira conhecimento que a busca, o Argos e o Claude usam. O
        arquivo original fica guardado para baixar.
        {eu.papel !== "admin" && " Como você não é administrador, os documentos entram como rascunho para aprovação."}
      </p>

      <div
        className={`${css.area} ${sobre ? css.areaSobre : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setSobre(true);
        }}
        onDragLeave={() => setSobre(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setSobre(false);
          adicionar(e.dataTransfer.files);
        }}
      >
        <Upload size={22} aria-hidden="true" />
        <span>Arraste os arquivos aqui ou</span>
        <button type="button" className="botao botao-pequeno" onClick={() => campo.current?.click()}>
          Escolher arquivos
        </button>
        <span className="suave pequeno">PDF, Word, Excel, PowerPoint, texto ou CSV · até 25 MB cada</span>
        <input
          ref={campo}
          type="file"
          multiple
          accept={ACEITOS}
          className="so-leitor"
          aria-label="Escolher arquivos"
          onChange={(e) => {
            adicionar(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {itens.length > 0 && (
        <ul className={css.lista}>
          {itens.map((i, n) => (
            <li key={`${i.arquivo.name}-${n}`} className={css.item}>
              {i.estado === "ok" ? (
                <CheckCircle2 size={16} aria-hidden="true" className={css.ok} />
              ) : i.estado === "erro" ? (
                <XCircle size={16} aria-hidden="true" className={css.erro} />
              ) : (
                <FileText size={16} aria-hidden="true" className={i.estado === "enviando" ? css.enviando : undefined} />
              )}
              <span className={css.nome}>{i.arquivo.name}</span>
              <span className={`pequeno ${i.estado === "erro" ? css.erro : "suave"}`}>
                {i.estado === "enviando" ? "Lendo o arquivo…" : i.estado === "fila" ? "Pronto para enviar" : i.mensagem}
              </span>
              {i.codigo && (
                <Link to={`/registros/${i.codigo}`} className="pequeno">
                  Abrir {i.codigo}
                </Link>
              )}
              {i.estado === "fila" && (
                <button type="button" className="botao botao-fantasma botao-icone" aria-label={`Tirar ${i.arquivo.name}`} onClick={() => setItens((a) => a.filter((_, j) => j !== n))}>
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className={css.opcoes}>
        <label className="campo">
          <span className="rotulo">Área</span>
          <select className="selecao" value={area} onChange={(e) => setArea(e.target.value as Area)}>
            {AREAS.map((a) => (
              <option key={a} value={a}>
                {NOME_AREA[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="campo">
          <span className="rotulo">Acesso</span>
          <select className="selecao" value={acesso} onChange={(e) => setAcesso(e.target.value as "interno" | "restrito")}>
            <option value="interno">Interno (todos e a IA)</option>
            <option value="restrito">Restrito (não vai para a IA externa)</option>
          </select>
        </label>
        <button type="button" className="botao botao-primario" disabled={!naFila || enviando} onClick={() => void enviarTodos()}>
          {enviando ? "Enviando…" : naFila ? `Enviar ${naFila} ${naFila === 1 ? "arquivo" : "arquivos"}` : "Enviar"}
        </button>
      </div>
    </section>
  );
}
