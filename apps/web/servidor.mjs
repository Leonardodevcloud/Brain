// Servidor de produção da interface: entrega o build e faz proxy de /api e /mcp
// para os serviços internos do Railway. Assim tudo fica numa só origem.
// Sem dependências: só Node.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORTA = Number(process.env.PORT ?? 8080);
const RAIZ = fileURLToPath(new URL("./dist/", import.meta.url));
const DESTINOS = {
  "/api": process.env.API_INTERNA_URL ?? "http://localhost:3000",
  "/mcp": process.env.MCP_INTERNA_URL ?? "http://localhost:3001",
};

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const SEGURANCA = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function proxy(req, res, base) {
  const destino = new URL(req.url, base);
  const encaminhado = req.headers["x-forwarded-for"];
  const ip = req.socket.remoteAddress ?? "";
  const pedido = http.request(
    destino,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: destino.host,
        "x-forwarded-for": encaminhado ? `${encaminhado}, ${ip}` : ip,
        "x-forwarded-proto": req.headers["x-forwarded-proto"] ?? "https",
      },
    },
    (resposta) => {
      res.writeHead(resposta.statusCode ?? 502, resposta.headers);
      resposta.pipe(res);
    },
  );
  pedido.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ erro: { codigo: "indisponivel", mensagem: "O serviço está reiniciando. Tente de novo em instantes." } }));
  });
  req.pipe(pedido);
}

async function arquivo(req, res) {
  const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const seguro = normalize(join(RAIZ, caminho));
  let alvo = seguro.startsWith(RAIZ) ? seguro : join(RAIZ, "index.html");
  try {
    if (!(await stat(alvo)).isFile()) throw new Error();
  } catch {
    alvo = join(RAIZ, "index.html"); // rotas da SPA
  }
  const ehAsset = alvo.includes(`${RAIZ}assets`);
  res.writeHead(200, {
    ...SEGURANCA,
    "content-type": TIPOS[extname(alvo)] ?? "application/octet-stream",
    "cache-control": ehAsset ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(alvo).pipe(res);
}

http
  .createServer((req, res) => {
    const url = req.url ?? "/";
    for (const [prefixo, base] of Object.entries(DESTINOS)) {
      if (url === prefixo || url.startsWith(`${prefixo}/`)) return proxy(req, res, base);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    void arquivo(req, res);
  })
  .listen(PORTA, () => console.log(`web no ar na porta ${PORTA}`));
