import type { DadosCentralDTO, GraficoDTO } from "@cerebro/core/publico";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import css from "./Grafico.module.css";

/**
 * Gráficos do Argos, desenhados em SVG com os números da consulta.
 * A IA só escolhe o tipo e as colunas (GraficoDTO); nada aqui vem do texto dela.
 */

export const CORES_SERIE = ["#a78bfa", "#67e8f9", "#f0abfc", "#fbbf24", "#4ade80", "#fb923c", "#60a5fa", "#f472b6"];

const MOEDA = /(valor|fatur|cobrado|pago|amount|receita|custo|preco|ticket|saldo)/i;
const PERCENTUAL = /(pct|percent|sla|taxa|margem)/i;

export const numero = (v: unknown): number | null =>
  typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;

const ehData = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?(T|$)/.test(v);

export const rotularColuna = (c: string) => {
  const t = c.replace(/_/g, " ").replace(/\bpct\b/i, "%").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Valor curto para eixo e etiqueta: 12,3 mil · R$ 1,2 mi · 87%. */
export function valorCurto(coluna: string, v: number, completo = false): string {
  if (PERCENTUAL.test(coluna)) return `${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
  const moeda = MOEDA.test(coluna);
  if (completo) return moeda ? v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  const abs = Math.abs(v);
  const [n, suf] = abs >= 1e6 ? [v / 1e6, " mi"] : abs >= 1e4 ? [v / 1e3, " mil"] : [v, ""];
  const txt = n.toLocaleString("pt-BR", { maximumFractionDigits: suf ? 1 : abs < 10 ? 2 : 0 }) + suf;
  return moeda ? `R$ ${txt}` : txt;
}

function rotuloX(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T12:00:00Z` : v);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: v.length === 10 ? "UTC" : "America/Bahia" });
  }
  if (typeof v === "string" && /^\d{4}-\d{2}$/.test(v)) {
    const [a, m] = v.split("-");
    return new Date(Number(a), Number(m) - 1, 1).toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }).replace(".", "");
  }
  return String(v);
}

/** Marcas "redondas" do eixo (0, 5, 10, 15…). */
function marcas(min: number, max: number, alvo = 4): number[] {
  if (max === min) max = min + 1;
  const passoBruto = (max - min) / alvo;
  const mag = 10 ** Math.floor(Math.log10(passoBruto));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= passoBruto) ?? 10 * mag;
  const ini = Math.floor(min / passo) * passo;
  const lista: number[] = [];
  for (let v = ini; v <= max + passo * 0.001; v += passo) lista.push(Math.round(v * 1e6) / 1e6);
  if (lista[lista.length - 1]! < max) lista.push(lista[lista.length - 1]! + passo);
  return lista;
}

/**
 * Sem sugestão da IA, a tela ainda oferece um gráfico quando os dados pedem:
 * uma coluna de datas + números (linha) ou um ranking curto (barras).
 */
export function sugerirGrafico(d: DadosCentralDTO): GraficoDTO | null {
  if (d.linhas.length < 2) return null;
  const amostra = d.linhas.slice(0, 20);
  const numericas = d.colunas.filter((c) => amostra.every((l) => l[c] === null || numero(l[c]) !== null) && amostra.some((l) => numero(l[c]) !== null));
  const datas = d.colunas.find((c) => amostra.every((l) => l[c] === null || ehData(l[c])) || /^(dia|data|mes|semana|hora)$/i.test(c));
  if (datas && d.linhas.length >= 3) {
    const y = numericas.filter((c) => c !== datas && !/^id$|_id$/i.test(c)).slice(0, 3);
    if (y.length) return { tipo: "linha", x: datas, y, titulo: null, principal: false };
  }
  const texto = d.colunas.find((c) => !numericas.includes(c));
  if (texto && d.linhas.length <= 15) {
    const y = numericas.filter((c) => !/^id$|_id$|^cod/i.test(c)).slice(0, 1);
    if (y.length) return { tipo: "barras", x: texto, y, titulo: null, principal: false };
  }
  return null;
}

function useLargura(padrao = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(padrao);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => setLargura(Math.max(260, Math.round(el.clientWidth)));
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, largura] as const;
}

type Dica = { x: number; y: number; titulo: string; linhas: { cor: string; texto: string }[] } | null;

function Linha({ dados, g, largura, alto }: { dados: DadosCentralDTO; g: GraficoDTO; largura: number; alto: number }) {
  const [dica, setDica] = useState<Dica>(null);
  // Datas em ordem crescente (consultas costumam vir da mais nova para a mais velha).
  let linhas = dados.linhas.filter((l) => l[g.x] !== null && l[g.x] !== undefined);
  if (linhas.length > 1 && ehData(linhas[0]![g.x]) && String(linhas[0]![g.x]) > String(linhas[linhas.length - 1]![g.x])) linhas = [...linhas].reverse();
  const valores = linhas.flatMap((l) => g.y.map((c) => numero(l[c]) ?? 0));
  const min = Math.min(0, ...valores), max = Math.max(...valores, 0);
  const eixo = marcas(min, max);
  // A margem esquerda cabe o maior rótulo do eixo ("R$ 15 mil").
  const maiorRotulo = Math.max(...eixo.map((v) => valorCurto(g.y[0]!, v).length));
  const W = largura, H = alto, m = { e: Math.round(maiorRotulo * 6.8 + 14), d: 14, t: 16, b: 26 };
  const lo = eixo[0]!, hi = eixo[eixo.length - 1]!;
  const n = linhas.length;
  const x = (i: number) => m.e + (n === 1 ? 0.5 : i / (n - 1)) * (W - m.e - m.d);
  const y = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const cadaX = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.e) / 70))));
  const pontos = (c: string) => linhas.map((l, i) => `${x(i).toFixed(1)},${y(numero(l[c]) ?? 0).toFixed(1)}`);
  const principal = g.y[0]!;
  const idMax = linhas.reduce((a, l, i) => ((numero(l[principal]) ?? -Infinity) > (numero(linhas[a]![principal]) ?? -Infinity) ? i : a), 0);

  function mover(e: PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.e) / (W - m.e - m.d)) * (n - 1))));
    const l = linhas[i]!;
    setDica({
      x: x(i),
      y: y(numero(l[principal]) ?? 0),
      titulo: rotuloX(l[g.x]),
      linhas: g.y.map((c, k) => ({ cor: CORES_SERIE[k]!, texto: `${g.y.length > 1 ? `${rotularColuna(c)}: ` : ""}${valorCurto(c, numero(l[c]) ?? 0, true)}` })),
    });
  }

  return (
    <div className={css.area}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={g.titulo ?? `Gráfico de linha de ${g.y.map(rotularColuna).join(", ")}`} onPointerMove={mover} onPointerLeave={() => setDica(null)}>
        <defs>
          <linearGradient id="argos-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={CORES_SERIE[0]} stopOpacity="0.4" />
            <stop offset="1" stopColor={CORES_SERIE[0]} stopOpacity="0" />
          </linearGradient>
        </defs>
        {eixo.map((v) => (
          <g key={v}>
            <line x1={m.e} x2={W - m.d} y1={y(v)} y2={y(v)} className={css.grade} />
            <text x={m.e - 8} y={y(v) + 4} textAnchor="end" className={css.eixo}>
              {valorCurto(principal, v)}
            </text>
          </g>
        ))}
        {linhas.map((l, i) =>
          (i % cadaX === 0 && (i === 0 || n - 1 - i >= cadaX * 0.7)) || i === n - 1 ? (
            <text key={i} x={x(i)} y={H - 7} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className={css.eixo}>
              {rotuloX(l[g.x])}
            </text>
          ) : null,
        )}
        {n > 1 && <path d={`M${pontos(principal).join(" L")} L${x(n - 1)},${y(lo)} L${x(0)},${y(lo)} Z`} fill="url(#argos-area)" />}
        {g.y.map((c, k) => (
          <polyline key={c} points={pontos(c).join(" ")} fill="none" stroke={CORES_SERIE[k]} strokeWidth={k === 0 ? 2.2 : 1.8} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {n > 2 && <circle cx={x(idMax)} cy={y(numero(linhas[idMax]![principal]) ?? 0)} r={4.5} fill="#67e8f9" />}
        <circle cx={x(n - 1)} cy={y(numero(linhas[n - 1]![principal]) ?? 0)} r={4} fill={CORES_SERIE[0]} stroke="#110f1b" strokeWidth={2} />
        {dica && (
          <>
            <line x1={dica.x} x2={dica.x} y1={m.t} y2={H - m.b} className={css.guia} />
            <circle cx={dica.x} cy={dica.y} r={4} fill="#fff" />
          </>
        )}
      </svg>
      {dica && (
        <div className={css.dica} style={{ left: `${(dica.x / W) * 100}%`, top: `${(dica.y / H) * 100}%` }}>
          <b>{dica.titulo}</b>
          {dica.linhas.map((x) => (
            <span key={x.texto}>
              <i style={{ background: x.cor }} />
              {x.texto}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Barras({ dados, g, largura }: { dados: DadosCentralDTO; g: GraficoDTO; largura: number }) {
  const linhas = dados.linhas.slice(0, 15);
  const series = g.y;
  const alturaLinha = series.length > 1 ? 18 + series.length * 12 : 32;
  const rotulos = linhas.map((l) => rotuloX(l[g.x]));
  const W = largura;
  const e = Math.min(170, Math.max(64, Math.max(...rotulos.map((r) => r.length)) * 7 + 12));
  const d = 64;
  const H = linhas.length * alturaLinha + 8;
  const max = Math.max(...linhas.flatMap((l) => series.map((c) => numero(l[c]) ?? 0)), 0) || 1;
  const largo = (v: number) => (Math.max(0, v) / max) * (W - e - d);
  const corte = (t: string) => (t.length * 7 > e - 10 ? `${t.slice(0, Math.floor((e - 10) / 7) - 1)}…` : t);
  return (
    <div className={css.area}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={g.titulo ?? `Gráfico de barras de ${series.map(rotularColuna).join(", ")}`}>
        {linhas.map((l, i) => {
          const y0 = 4 + i * alturaLinha;
          return (
            <g key={i}>
              <title>{`${rotulos[i]}: ${series.map((c) => valorCurto(c, numero(l[c]) ?? 0, true)).join(" · ")}`}</title>
              <text x={e - 10} y={y0 + alturaLinha / 2 + 4} textAnchor="end" className={css.rotuloBarra}>
                {corte(rotulos[i]!)}
              </text>
              {series.map((c, k) => {
                const v = numero(l[c]) ?? 0;
                const alt = series.length > 1 ? 9 : alturaLinha - 14;
                const yb = series.length > 1 ? y0 + 9 + k * 12 : y0 + 7;
                return (
                  <g key={c}>
                    {k === 0 && <rect x={e} y={y0 + 5} width={W - e - d} height={alturaLinha - 10} rx={5} className={css.trilho} />}
                    <rect x={e} y={yb} width={largo(v)} height={alt} rx={4} fill={series.length > 1 ? CORES_SERIE[k] : i === 0 ? "#8b5cf6" : "#6d4fd1"} className={css.barra} />
                    <text x={e + largo(v) + 7} y={yb + alt / 2 + 4} className={css.valorBarra}>
                      {valorCurto(c, v)}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Pizza({ dados, g, largura }: { dados: DadosCentralDTO; g: GraficoDTO; largura: number }) {
  const c = g.y[0]!;
  const fatias = dados.linhas.map((l) => ({ nome: rotuloX(l[g.x]), v: Math.max(0, numero(l[c]) ?? 0) })).filter((f) => f.v > 0);
  const total = fatias.reduce((s, f) => s + f.v, 0) || 1;
  const lado = Math.min(220, largura * 0.45);
  const R = lado / 2 - 4, r = R * 0.6, cx = lado / 2, cy = lado / 2;
  let ang = -Math.PI / 2;
  const arcos = fatias.map((f, i) => {
    const a0 = ang, a1 = ang + (f.v / total) * Math.PI * 2;
    ang = a1;
    const grande = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    const d =
      fatias.length === 1
        ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0 M${cx - r},${cy} a${r},${r} 0 1,1 ${2 * r},0 a${r},${r} 0 1,1 ${-2 * r},0`
        : `M${p(R, a0)} A${R},${R} 0 ${grande} 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 ${grande} 0 ${p(r, a0)} Z`;
    return { ...f, d, cor: CORES_SERIE[i % CORES_SERIE.length]! };
  });
  return (
    <div className={`${css.area} ${css.pizza}`}>
      <svg viewBox={`0 0 ${lado} ${lado}`} width={lado} height={lado} role="img" aria-label={g.titulo ?? `Gráfico de pizza de ${rotularColuna(c)}`}>
        {arcos.map((a) => (
          <path key={a.nome} d={a.d} fill={a.cor} fillRule="evenodd" stroke="#110f1b" strokeWidth={1.5}>
            <title>{`${a.nome}: ${valorCurto(c, a.v, true)}`}</title>
          </path>
        ))}
        <text x={cx} y={cy - 2} textAnchor="middle" className={css.totalPizza}>
          {valorCurto(c, total)}
        </text>
        <text x={cx} y={cy + 15} textAnchor="middle" className={css.eixo}>
          total
        </text>
      </svg>
      <ul className={css.legenda}>
        {arcos.map((a) => (
          <li key={a.nome}>
            <i style={{ background: a.cor }} />
            <span>{a.nome}</span>
            <b>{Math.round((a.v / total) * 100)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Grafico({ dados, grafico, alto = 230 }: { dados: DadosCentralDTO; grafico: GraficoDTO; alto?: number }) {
  const [ref, largura] = useLargura();
  return (
    <div ref={ref} className={css.grafico}>
      {grafico.y.length > 1 && grafico.tipo !== "pizza" && (
        <ul className={css.series}>
          {grafico.y.map((c, k) => (
            <li key={c}>
              <i style={{ background: CORES_SERIE[k] }} />
              {rotularColuna(c)}
            </li>
          ))}
        </ul>
      )}
      {grafico.tipo === "linha" ? (
        <Linha dados={dados} g={grafico} largura={largura} alto={alto} />
      ) : grafico.tipo === "barras" ? (
        <Barras dados={dados} g={grafico} largura={largura} />
      ) : (
        <Pizza dados={dados} g={grafico} largura={largura} />
      )}
    </div>
  );
}
