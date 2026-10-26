import Markdown from "react-markdown";
import { Link } from "react-router-dom";
import remarkGfm from "remark-gfm";

/** Markdown seguro (sem HTML cru). Links internos para registros viram navegação da SPA. */
export function Conteudo({ texto }: { texto: string }) {
  return (
    <div className="prosa">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            href?.startsWith("/") ? (
              <Link to={href}>{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
        }}
      >
        {texto}
      </Markdown>
    </div>
  );
}
