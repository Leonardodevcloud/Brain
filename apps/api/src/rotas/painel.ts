import express, { Router } from "express";
import { AppError } from "@cerebro/core";
import { agendarRegrasDoCodigo, auditar, LIMITE_AUDIO_BYTES, LIMITE_PLANILHA_BYTES, acesso, apagarConversa, gravarConversa, listarConversas, obterConversa, atenderFala, guardarPlanilha, memorizar, configVoz, falaEmCurso, fontes, gerarFala, montarMapa, painel, prepararFala, salvarVoz, transcreverFala } from "@cerebro/servicos";
import { z } from "zod";
import { ator, esquemaId, exigirAdmin, validar, type Deps } from "../http/base.js";

const esquemaNovoUsuario = z.object({
  nome: z.string().trim().min(2).max(120),
  email: z.email().max(200),
  senha: z.string().min(1).max(200),
  papel: z.enum(["admin", "membro"]).default("membro"),
});

const esquemaEditarUsuario = z
  .object({
    nome: z.string().trim().min(2).max(120).optional(),
    email: z.email().max(200).optional(),
    papel: z.enum(["admin", "membro"]).optional(),
    ativo: z.boolean().optional(),
    novaSenha: z.string().min(1).max(200).optional(),
  })
  .strict();

/** Rotas de tela: início, lacunas, usuários, integrações, conector e importação. Todas exigem login. */
export function rotasPainel({ ctx }: Deps) {
  const r = Router();

  r.get("/inicio", async (_req, res) => {
    res.json(await painel.resumoInicio(ctx));
  });

  // ── Argos (assistente de voz) ──
  r.post(
    "/argos/transcrever",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: LIMITE_AUDIO_BYTES }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw AppError.requisicaoInvalida("Envie o áudio gravado.");
      const texto = await transcreverFala(ctx, new Uint8Array(req.body), req.get("content-type") ?? "audio/webm");
      res.json({ texto });
    },
  );

  r.post("/argos", async (req, res) => {
    const { texto, historico, falar, anexo } = validar(
      z.object({
        texto: z.string().trim().min(2).max(1000),
        // Últimas trocas da conversa, para perguntas de continuação ("e em Salvador?").
        historico: z
          .array(z.object({ pergunta: z.string().max(1000), resposta: z.string().max(4000), em: z.string().max(40).optional() }))
          .max(10)
          .default([]),
        // A interface vai falar a resposta: o servidor já adianta a voz do 1º trecho.
        falar: z.boolean().default(false),
        // Planilha anexada na conversa (id devolvido por POST /argos/anexos).
        anexo: z.uuid().nullish(),
      }),
      req.body,
    );
    res.json(await atenderFala(ctx, ator(req), texto, historico, { falar, anexo }));
  });

  // ── Conversas do Argos (lista da tela Perguntar): cada pessoa só vê as suas ──
  r.get("/conversas", async (req, res) => {
    const { busca } = validar(z.object({ busca: z.string().trim().max(120).optional() }), req.query);
    res.json(await listarConversas(ctx, ator(req), busca));
  });
  r.get("/conversas/:id", async (req, res) => {
    const { id } = validar(z.object({ id: z.uuid() }), req.params);
    res.json(await obterConversa(ctx, ator(req), id));
  });
  r.put("/conversas/:id", async (req, res) => {
    const { id } = validar(z.object({ id: z.uuid() }), req.params);
    const { turnos } = validar(
      z.object({
        turnos: z
          .array(
            z.object({
              pergunta: z.string().max(1000),
              resposta: z.record(z.string(), z.unknown()).nullable(),
              erro: z.string().max(1000).nullable(),
              em: z.number(),
              guardadas: z.array(z.record(z.string(), z.unknown())).max(10).optional(),
            }),
          )
          .min(1)
          .max(60),
      }),
      req.body,
    );
    res.json(await gravarConversa(ctx, ator(req), id, turnos as never));
  });
  r.delete("/conversas/:id", async (req, res) => {
    const { id } = validar(z.object({ id: z.uuid() }), req.params);
    await apagarConversa(ctx, ator(req), id);
    res.status(204).end();
  });

  // Depois de cada resposta, a interface pede para o Argos guardar o que valer (memória automática).
  r.post("/argos/memorizar", async (req, res) => {
    const troca = validar(
      z.object({
        pergunta: z.string().trim().min(1).max(1000),
        resposta: z.string().max(6000),
        historico: z
          .array(z.object({ pergunta: z.string().max(1000), resposta: z.string().max(4000), em: z.string().max(40).optional() }))
          .max(10)
          .default([]),
      }),
      req.body,
    );
    res.json({ guardadas: await memorizar(ctx, ator(req), troca) });
  });

  // Planilha para analisar na conversa (.xlsx ou .csv). O nome vem na URL; o arquivo, no corpo.
  r.post("/argos/anexos", express.raw({ type: () => true, limit: LIMITE_PLANILHA_BYTES }), async (req, res) => {
    const { nome } = validar(z.object({ nome: z.string().trim().min(3).max(200) }), req.query);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw AppError.requisicaoInvalida("Envie a planilha.");
    res.status(201).json(guardarPlanilha(ator(req), nome, new Uint8Array(req.body)));
  });

  // Voz do Argos: gerada no servidor, a mesma em qualquer aparelho.
  r.get("/argos/voz", async (_req, res) => {
    res.json(await configVoz(ctx));
  });
  r.put("/argos/voz", exigirAdmin, async (req, res) => {
    const entrada = validar(z.object({ voz: z.string().min(2).max(30), velocidade: z.number().min(0.8).max(1.5) }), req.body);
    res.json(await salvarVoz(ctx, ator(req), entrada));
  });
  r.post("/argos/falar", async (req, res) => {
    const { texto, voz, velocidade } = validar(
      z.object({ texto: z.string().trim().min(1).max(1200), voz: z.string().max(30).optional(), velocidade: z.number().min(0.8).max(1.5).optional() }),
      req.body,
    );
    // Testar outra voz é coisa de quem escolhe a voz (o administrador).
    const teste = voz || velocidade ? (req.ator?.papel === "admin" ? { voz, velocidade } : undefined) : undefined;
    const audio = await gerarFala(ctx, texto, teste);
    res.set({ "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" });
    res.send(Buffer.from(audio));
  });
  // Começa a gerar a voz e devolve o id; o áudio sai em fluxo em GET /argos/falar/:id (rota sem login, ver rotasFala).
  r.post("/argos/falar/preparar", async (req, res) => {
    const { texto } = validar(z.object({ texto: z.string().trim().min(1).max(1200) }), req.body);
    res.json({ id: await prepararFala(ctx, texto) });
  });

  r.get("/mapa", async (_req, res) => {
    res.json(await montarMapa(ctx));
  });

  r.get("/lacunas", async (_req, res) => {
    res.json(await painel.listarLacunas(ctx));
  });

  r.post("/lacunas/:id/resolver", async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    const { registroId } = validar(z.object({ registroId: z.uuid().nullish() }), req.body ?? {});
    await painel.resolverLacuna(ctx, ator(req), id, registroId ?? null);
    res.status(204).end();
  });

  // ── Usuários ──
  r.get("/usuarios", async (_req, res) => {
    res.json(await acesso.listarUsuarios(ctx));
  });

  r.post("/usuarios", exigirAdmin, async (req, res) => {
    res.status(201).json(await acesso.criarUsuario(ctx, ator(req), validar(esquemaNovoUsuario, req.body)));
  });

  r.patch("/usuarios/:id", exigirAdmin, async (req, res) => {
    const { id } = validar(esquemaId, req.params);
    res.json(await acesso.editarUsuario(ctx, ator(req), id, validar(esquemaEditarUsuario, req.body)));
  });

  // ── Integrações ──
  r.get("/integracoes", async (req, res) => {
    res.json(await painel.statusIntegracoes(ctx, ator(req)));
  });

  r.post("/integracoes/google/conectar", exigirAdmin, async (req, res) => {
    res.json({ url: await painel.iniciarConexaoGoogle(ctx, ator(req)) });
  });

  r.delete("/integracoes/google", exigirAdmin, async (req, res) => {
    res.json(await painel.desconectarGoogle(ctx, ator(req)));
  });

  // Relê as regras de negócio do código da Central (o worker faz em segundo plano).
  r.post("/integracoes/codigo-central/ler", exigirAdmin, async (req, res) => {
    if (!ctx.ambiente.CENTRAL_GITHUB_TOKEN) throw AppError.requisicaoInvalida("Defina CENTRAL_GITHUB_TOKEN no Railway para ler o código da Central.");
    const forcar = (req.body as { forcar?: unknown } | undefined)?.forcar === true;
    await agendarRegrasDoCodigo(ctx, forcar);
    await auditar(ctx.pool, ator(req), "integracao.codigo_central", undefined, { forcar });
    res.status(202).json({ agendado: true });
  });

  r.get("/integracoes/fila", exigirAdmin, async (_req, res) => {
    res.json(await painel.saudeFila(ctx));
  });

  // ── Conector do Claude (tokens pessoais) ──
  r.get("/conector/tokens", async (req, res) => {
    res.json(await acesso.listarTokensConector(ctx, ator(req)));
  });

  r.post("/conector/tokens", async (req, res) => {
    const { nome } = validar(z.object({ nome: z.string().trim().min(2).max(60) }), req.body);
    res.status(201).json(await acesso.criarTokenConector(ctx, ator(req), nome));
  });

  r.delete("/conector/tokens/:id", async (req, res) => {
    await acesso.revogarTokenConector(ctx, ator(req), validar(esquemaId, req.params).id);
    res.status(204).end();
  });

  // ── Importação do Claude: o .zip vai direto no corpo ──
  r.post(
    "/importacao/claude",
    exigirAdmin,
    express.raw({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: "150mb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw AppError.requisicaoInvalida("Envie o arquivo .zip exportado do Claude.");
      }
      try {
        res.json(await fontes.importarExportacaoClaude(ctx, ator(req), new Uint8Array(req.body)));
      } catch (erro) {
        if (erro instanceof AppError) throw erro;
        throw AppError.requisicaoInvalida("Não consegui ler o arquivo. Confira se é o .zip exportado em Configurações › Privacidade do Claude.");
      }
    },
  );

  return r;
}

/**
 * GET /argos/falar/:id — o áudio de uma fala preparada, entregue enquanto é gerado.
 * Fica fora do login porque o <audio> do navegador não manda o token; quem protege é o id
 * (aleatório, de uso curto, que só sai para quem está logado) e a validade de 3 minutos.
 */
export function rotasFala(_deps: Deps) {
  const r = Router();
  r.get("/argos/falar/:id", (req, res) => {
    const { id } = validar(z.object({ id: z.uuid() }), req.params);
    const f = falaEmCurso(id);
    if (!f) throw AppError.naoEncontrado("Essa fala");
    if (f.falhou && !f.pedacos.length) throw AppError.indisponivel("Não consegui gerar a voz agora.");
    res.status(200).set({ "content-type": "audio/mpeg", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.flushHeaders();
    let enviados = 0;
    const enviar = () => {
      while (enviados < f.pedacos.length) res.write(Buffer.from(f.pedacos[enviados++]!));
      if (f.terminou) {
        f.avisar.delete(enviar);
        res.end();
      }
    };
    f.avisar.add(enviar);
    req.on("close", () => f.avisar.delete(enviar));
    enviar();
  });
  return r;
}
