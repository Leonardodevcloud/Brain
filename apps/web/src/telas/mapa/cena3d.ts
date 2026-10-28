/**
 * Mapa em partículas (3D): cada área é um aglomerado brilhante, os registros são estrelas
 * em volta dele, e pontos de luz correm pelas ligações. Tudo em Three.js, com o movimento
 * calculado na placa de vídeo. A tela do mapa conversa com isto só por métodos (focar, enquadrar…)
 * e eventos (apontou, clicou), como fazia com o grafo 2D.
 */
import type * as Tres from "three";
import type { ModuloThree } from "../../componentes/particulas/nebulosa";
import { COR_AREA } from "./cores";
import { corDoNo, idDe, type Ligacao, type No } from "./desenho";

export interface EventosCena {
  apontou: (id: string | null) => void;
  clicou: (id: string | null) => void;
}

const FRAG = /* glsl */ `varying vec3 vCor; varying float vAlfa;
void main(){ vec2 c=gl_PointCoord-.5; float d=length(c);
  float nucleo=smoothstep(.14,.0,d); float halo=pow(smoothstep(.5,.0,d),1.8);
  float a=(nucleo*.9+halo*.7)*vAlfa; if(a<.004) discard;
  // Cor da área no halo; só o miolo puxa para o branco (sem estourar tudo em branco).
  vec3 cor=mix(vCor,vec3(1.),nucleo*.45)*nucleo+vCor*halo*.65;
  gl_FragColor=vec4(cor,a); }`;

/** Número estável a partir de um texto: o mesmo registro cai sempre no mesmo lugar. */
function semente(texto: string) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) h = Math.imul(h ^ texto.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => {
  const u = Math.max(1e-6, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
};

interface NoCena {
  no: No;
  pos: Tres.Vector3;
  cor: Tres.Color;
  indice: number;
}

export class Cena3D {
  private renderer: Tres.WebGLRenderer;
  private cena: Tres.Scene;
  private camera: Tres.PerspectiveCamera;
  private mundo: Tres.Group;
  private conteudo: Tres.Group;
  private poeiraFundo: Tres.Points;
  private nosCena: NoCena[] = [];
  private porId = new Map<string, NoCena>();
  private ligacoes: { a: NoCena; b: NoCena; curva: Tres.QuadraticBezierCurve3; segmentos: number; inicio: number }[] = [];
  private geoNos: Tres.BufferGeometry | null = null;
  private geoLinhas: Tres.BufferGeometry | null = null;
  private geoPulsos: Tres.BufferGeometry | null = null;
  private pulsoDaLigacao: number[] = [];
  private uniforms = { uT: { value: 0 }, uPx: { value: 1 }, uAlturaTela: { value: 800 } };
  private rotulos: { el: HTMLElement; alvo: NoCena }[] = [];
  private rotuloFoco: HTMLElement;
  private quadro = 0;
  private antes = performance.now();
  private visivel = true;
  private ro: ResizeObserver;
  private io: IntersectionObserver;

  // Câmera orbital
  private yaw = 0.5;
  private pitch = 0.22;
  private distancia = 18;
  private alvo: Tres.Vector3;
  private destino: { alvo: Tres.Vector3; distancia: number } | null = null;
  private parado = 10;
  /** Gira sozinho só na visão geral, até a pessoa mexer (depois fica onde ela deixou). */
  private girarSozinho = true;
  private modoArraste: "girar" | "mover" = "girar";
  private meioToques: { x: number; y: number } | null = null;
  private arraste: { x: number; y: number; moveu: number } | null = null;
  private toques = new Map<number, { x: number; y: number }>();
  private pinca: number | null = null;
  private apontado: string | null = null;
  private deslocamento = { x: 0, y: 0 };
  private v: Tres.Vector3;

  constructor(
    private THREE: ModuloThree,
    private canvas: HTMLCanvasElement,
    private camadaRotulos: HTMLElement,
    private eventos: EventosCena,
    private movimento: boolean,
    private leve: boolean,
  ) {
    const T = THREE;
    this.v = new T.Vector3();
    this.alvo = new T.Vector3();
    this.renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, leve ? 1.5 : 2));
    this.renderer.setClearColor(0x000000, 0);
    this.uniforms.uPx.value = this.renderer.getPixelRatio();
    this.cena = new T.Scene();
    this.camera = new T.PerspectiveCamera(45, 1, 0.1, 200);
    this.mundo = new T.Group();
    this.cena.add(this.mundo);
    this.conteudo = new T.Group();
    this.mundo.add(this.conteudo);

    // Poeira de fundo: estrelas soltas bem longe.
    const q = leve ? 900 : 2200;
    const pp: number[] = [];
    const r = semente("fundo");
    for (let i = 0; i < q; i++) {
      const d = new T.Vector3(gauss(r), gauss(r), gauss(r)).normalize().multiplyScalar(22 + r() * 30);
      pp.push(d.x, d.y, d.z);
    }
    const gf = new T.BufferGeometry();
    gf.setAttribute("position", new T.Float32BufferAttribute(pp, 3));
    this.poeiraFundo = new T.Points(
      gf,
      new T.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: `uniform float uPx; varying vec3 vCor; varying float vAlfa;
          void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vCor=vec3(.6,.65,.85); vAlfa=.5; gl_PointSize=70.*uPx/-mv.z; gl_Position=projectionMatrix*mv; }`,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    this.cena.add(this.poeiraFundo);

    this.rotuloFoco = document.createElement("div");
    this.rotuloFoco.className = "mapa3d-foco";
    this.rotuloFoco.hidden = true;
    camadaRotulos.appendChild(this.rotuloFoco);

    this.ro = new ResizeObserver(() => this.medir());
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => {
      this.visivel = Boolean(e?.isIntersecting);
    });
    this.io.observe(canvas);
    this.ligarControles();
    this.medir();
    this.quadro = requestAnimationFrame(this.animar);
  }

  /** Troca os nós e ligações (filtros, dados novos). Posições são estáveis por id. */
  definirDados(nos: No[], ligacoes: Ligacao[]) {
    const T = this.THREE;
    this.limparConteudo();
    const areas = nos.filter((n) => n.categoria === "area");
    const ouro = Math.PI * (3 - Math.sqrt(5));
    const raioCasca = 2.4 + Math.sqrt(Math.max(1, nos.length)) * 0.24;
    const posArea = new Map<string, Tres.Vector3>();
    areas.forEach((a, i) => {
      const y = areas.length === 1 ? 0 : 1 - (i / (areas.length - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = ouro * i;
      const p = new T.Vector3(Math.cos(th) * r * raioCasca, y * raioCasca * 0.7, Math.sin(th) * r * raioCasca);
      posArea.set(a.area ?? a.id, p);
    });
    const porArea = new Map<string, number>();
    for (const n of nos) if (n.categoria === "registro" && n.area) porArea.set(n.area, (porArea.get(n.area) ?? 0) + 1);

    this.nosCena = [];
    this.porId.clear();
    // Registros e áreas primeiro; clientes depois (ficam no meio dos registros ligados a eles).
    const ordem = [...nos.filter((n) => n.categoria !== "cliente"), ...nos.filter((n) => n.categoria === "cliente")];
    const ligadosA = new Map<string, string[]>();
    for (const l of ligacoes) {
      const a = idDe(l.origem);
      const b = idDe(l.destino);
      ligadosA.set(a, [...(ligadosA.get(a) ?? []), b]);
      ligadosA.set(b, [...(ligadosA.get(b) ?? []), a]);
    }
    for (const n of ordem) {
      const r = semente(n.id);
      let pos: Tres.Vector3;
      if (n.categoria === "area") pos = posArea.get(n.area ?? n.id)!.clone();
      else if (n.categoria === "cliente") {
        const viz = (ligadosA.get(n.id) ?? []).map((id) => this.porId.get(id)?.pos).filter(Boolean) as Tres.Vector3[];
        const media = viz.length ? viz.reduce((s, p) => s.add(p), new T.Vector3()).multiplyScalar(1 / viz.length) : new T.Vector3();
        pos = media.multiplyScalar(1.18).add(new T.Vector3(gauss(r), gauss(r), gauss(r)).multiplyScalar(0.35));
      } else {
        const centro = n.area ? posArea.get(n.area) : undefined;
        const espalhar = 0.55 + Math.sqrt(porArea.get(n.area ?? "") ?? 1) * 0.16;
        pos = (centro?.clone() ?? new T.Vector3()).add(new T.Vector3(gauss(r), gauss(r) * 0.8, gauss(r)).multiplyScalar(centro ? espalhar : 1.6));
      }
      const nc: NoCena = { no: n, pos, cor: new T.Color(corDoNo(n)), indice: this.nosCena.length };
      this.nosCena.push(nc);
      this.porId.set(n.id, nc);
    }

    // Estrelas (nós)
    const total = this.nosCena.length;
    const pos = new Float32Array(total * 3);
    const cor = new Float32Array(total * 3);
    const tam = new Float32Array(total);
    const foco = new Float32Array(total);
    const alfa = new Float32Array(total);
    const sem = new Float32Array(total);
    const branco = new T.Color("#ffffff");
    for (const nc of this.nosCena) {
      const i = nc.indice;
      pos.set([nc.pos.x, nc.pos.y, nc.pos.z], i * 3);
      const c = nc.no.categoria === "area" ? nc.cor.clone().lerp(branco, 0.55) : nc.cor;
      cor.set([c.r, c.g, c.b], i * 3);
      tam[i] = nc.no.categoria === "area" ? 2.6 : nc.no.categoria === "cliente" ? 1.5 : 1 + Math.min(1.2, Math.sqrt(nc.no.grau) * 0.22);
      alfa[i] = nc.no.status === "rascunho" ? 0.5 : 1;
      sem[i] = semente(nc.no.id)();
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("aCor", new T.BufferAttribute(cor, 3));
    g.setAttribute("aTam", new T.BufferAttribute(tam, 1));
    g.setAttribute("aFoco", new T.BufferAttribute(foco, 1));
    g.setAttribute("aAlfa", new T.BufferAttribute(alfa, 1));
    g.setAttribute("aSem", new T.BufferAttribute(sem, 1));
    this.geoNos = g;
    this.conteudo.add(
      new T.Points(
        g,
        new T.ShaderMaterial({
          uniforms: this.uniforms,
          vertexShader: `uniform float uT,uPx; attribute vec3 aCor; attribute float aTam,aFoco,aAlfa,aSem; varying vec3 vCor; varying float vAlfa;
            void main(){ vec4 mv=modelViewMatrix*vec4(position,1.);
              float pisca=.85+.15*sin(uT*(1.5+aSem*2.)+aSem*30.);
              float apaga=aFoco<0. ? .18 : 1.;
              vCor=min(aCor*(1.+max(aFoco,0.)*.5),vec3(1.)); vAlfa=pisca*aAlfa*apaga;
              gl_PointSize=(130.*aTam*(1.+max(aFoco,0.)*.9)+aSem*30.)*uPx/-mv.z; gl_Position=projectionMatrix*mv; }`,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          blending: T.AdditiveBlending,
        }),
      ),
    );

    // Poeira de cada aglomerado
    const dp: number[] = [];
    const dc: number[] = [];
    const porHub = this.leve ? 160 : 380;
    for (const nc of this.nosCena.filter((x) => x.no.categoria === "area")) {
      const r = semente(`poeira-${nc.no.id}`);
      const qtd = Math.round(porHub * Math.min(2, 0.6 + Math.sqrt(porArea.get(nc.no.area ?? "") ?? 1) * 0.25));
      for (let i = 0; i < qtd; i++) {
        const p = nc.pos.clone().add(new T.Vector3(gauss(r), gauss(r) * 0.7, gauss(r)).multiplyScalar(0.55 + r() * 0.9));
        dp.push(p.x, p.y, p.z);
        dc.push(nc.cor.r, nc.cor.g, nc.cor.b);
      }
    }
    const gd = new T.BufferGeometry();
    gd.setAttribute("position", new T.Float32BufferAttribute(dp, 3));
    gd.setAttribute("color", new T.Float32BufferAttribute(dc, 3));
    this.conteudo.add(
      new T.Points(
        gd,
        new T.ShaderMaterial({
          uniforms: this.uniforms,
          vertexShader: `uniform float uPx; attribute vec3 color; varying vec3 vCor; varying float vAlfa;
            void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vCor=color; vAlfa=.5; gl_PointSize=50.*uPx/-mv.z; gl_Position=projectionMatrix*mv; }`,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          blending: T.AdditiveBlending,
        }),
      ),
    );

    // Ligações: retas dentro da área, arcos entre áreas e para "parecidos".
    this.ligacoes = [];
    const lp: number[] = [];
    const lc: number[] = [];
    for (const l of ligacoes) {
      const a = this.porId.get(idDe(l.origem));
      const b = this.porId.get(idDe(l.destino));
      if (!a || !b) continue;
      const arco = (a.no.area && b.no.area && a.no.area !== b.no.area) || l.tipo === "semelhante" || l.tipo === "cliente";
      const meio = a.pos.clone().add(b.pos).multiplyScalar(0.5);
      const ctrl = arco ? meio.clone().multiplyScalar(1.3).add(new T.Vector3(0, 0.6, 0)) : meio;
      const curva = new T.QuadraticBezierCurve3(a.pos, ctrl, b.pos);
      const segmentos = arco ? 20 : 1;
      const pts = curva.getPoints(segmentos);
      const inicio = lp.length / 3;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i]!;
        const p1 = pts[i + 1]!;
        lp.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        const c0 = a.cor.clone().lerp(b.cor, i / segmentos);
        const c1 = a.cor.clone().lerp(b.cor, (i + 1) / segmentos);
        const al = l.tipo === "area" ? 0.14 : l.tipo === "semelhante" ? 0.08 : 0.2;
        lc.push(c0.r, c0.g, c0.b, al, c1.r, c1.g, c1.b, al);
      }
      this.ligacoes.push({ a, b, curva, segmentos, inicio });
    }
    const gl = new T.BufferGeometry();
    gl.setAttribute("position", new T.Float32BufferAttribute(lp, 3));
    gl.setAttribute("color", new T.Float32BufferAttribute(lc, 4));
    gl.userData.alfaBase = lc.filter((_, i) => i % 4 === 3);
    this.geoLinhas = gl;
    this.conteudo.add(
      new T.LineSegments(gl, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false })),
    );

    // Pulsos de luz pelas ligações (a posição na curva é calculada no shader)
    const q0: number[] = [];
    const q1: number[] = [];
    const q2: number[] = [];
    const qo: number[] = [];
    const qv: number[] = [];
    const qc: number[] = [];
    const qf: number[] = [];
    this.pulsoDaLigacao = [];
    this.ligacoes.forEach((l, k) => {
      const qtd = l.segmentos > 1 ? 2 : 1;
      for (let j = 0; j < qtd; j++) {
        const r = semente(`${l.a.no.id}-${l.b.no.id}-${j}`);
        q0.push(l.curva.v0.x, l.curva.v0.y, l.curva.v0.z);
        q1.push(l.curva.v1.x, l.curva.v1.y, l.curva.v1.z);
        q2.push(l.curva.v2.x, l.curva.v2.y, l.curva.v2.z);
        qo.push(r());
        qv.push(l.segmentos > 1 ? 0.1 + r() * 0.08 : 0.22 + r() * 0.22);
        const c = l.segmentos > 1 ? l.a.cor.clone().lerp(new T.Color("#ffffff"), 0.4) : l.a.cor;
        qc.push(c.r, c.g, c.b);
        qf.push(0);
        this.pulsoDaLigacao.push(k);
      }
    });
    const gq = new T.BufferGeometry();
    gq.setAttribute("position", new T.Float32BufferAttribute(new Array(qo.length * 3).fill(0), 3));
    gq.setAttribute("aP0", new T.Float32BufferAttribute(q0, 3));
    gq.setAttribute("aP1", new T.Float32BufferAttribute(q1, 3));
    gq.setAttribute("aP2", new T.Float32BufferAttribute(q2, 3));
    gq.setAttribute("aOff", new T.Float32BufferAttribute(qo, 1));
    gq.setAttribute("aVel", new T.Float32BufferAttribute(qv, 1));
    gq.setAttribute("aCor", new T.Float32BufferAttribute(qc, 3));
    gq.setAttribute("aFoco", new T.Float32BufferAttribute(qf, 1));
    this.geoPulsos = gq;
    const pulsos = new T.Points(
      gq,
      new T.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: `uniform float uT,uPx; attribute vec3 aP0,aP1,aP2,aCor; attribute float aOff,aVel,aFoco; varying vec3 vCor; varying float vAlfa;
          void main(){ float t=fract(aOff+uT*aVel*(1.+max(aFoco,0.))); float u=1.-t;
            vec3 p=u*u*aP0+2.*u*t*aP1+t*t*aP2;
            vec4 mv=modelViewMatrix*vec4(p,1.);
            vCor=min(aCor*(1.1+max(aFoco,0.)*.4),vec3(1.)); vAlfa=sin(t*3.14159)*(aFoco<0. ? .1 : 1.);
            gl_PointSize=(80.+max(aFoco,0.)*50.)*uPx/-mv.z; gl_Position=projectionMatrix*mv; }`,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
      }),
    );
    pulsos.frustumCulled = false;
    this.conteudo.add(pulsos);

    // Rótulos das áreas (HTML, acompanham a câmera)
    for (const r of this.rotulos) r.el.remove();
    this.rotulos = this.nosCena
      .filter((x) => x.no.categoria === "area")
      .map((alvo) => {
        const el = document.createElement("span");
        el.className = "mapa3d-hub";
        const nome = document.createElement("span");
        nome.textContent = alvo.no.rotulo;
        const qtd = document.createElement("i");
        qtd.textContent = String(porArea.get(alvo.no.area ?? "") ?? 0);
        el.append(nome, qtd);
        el.style.setProperty("--c", alvo.no.area ? COR_AREA[alvo.no.area] : "#e2e8f0");
        this.camadaRotulos.appendChild(el);
        return { el, alvo };
      });
  }

  /** Destaca um nó e seus vizinhos (o resto apaga). Vazio = sem destaque. */
  destacar(ids: Set<string>, principal: string | null) {
    const g = this.geoNos;
    if (!g) return;
    const foco = g.getAttribute("aFoco") as Tres.BufferAttribute;
    const algum = ids.size > 0;
    for (const nc of this.nosCena) foco.setX(nc.indice, !algum ? 0 : nc.no.id === principal ? 1 : ids.has(nc.no.id) ? 0.45 : -1);
    foco.needsUpdate = true;
    const gl = this.geoLinhas;
    if (gl) {
      const cor = gl.getAttribute("color") as Tres.BufferAttribute;
      const base = gl.userData.alfaBase as number[];
      for (const l of this.ligacoes) {
        const emFoco = principal !== null && (l.a.no.id === principal || l.b.no.id === principal);
        for (let s = 0; s < l.segmentos * 2; s++) {
          const i = l.inicio + s;
          cor.setW(i, !algum ? base[i]! : emFoco ? 0.85 : base[i]! * 0.25);
        }
      }
      cor.needsUpdate = true;
    }
    const gq = this.geoPulsos;
    if (gq) {
      const f = gq.getAttribute("aFoco") as Tres.BufferAttribute;
      this.pulsoDaLigacao.forEach((k, i) => {
        const l = this.ligacoes[k]!;
        const emFoco = principal !== null && (l.a.no.id === principal || l.b.no.id === principal);
        f.setX(i, !algum ? 0 : emFoco ? 1 : -1);
      });
      f.needsUpdate = true;
    }
    this.mostrarRotuloFoco(principal);
  }

  /** Leva a câmera até o nó (o painel lateral ocupa a direita; a nuvem fica na área livre). */
  focar(id: string, perto = true) {
    const nc = this.porId.get(id);
    if (!nc) return;
    this.destino = { alvo: nc.pos.clone(), distancia: perto ? (nc.no.categoria === "area" ? 8 : 5.5) : this.distancia };
    this.parado = 0;
    this.girarSozinho = false;
  }

  enquadrar() {
    if (!this.nosCena.length) return;
    const centro = new this.THREE.Vector3();
    for (const nc of this.nosCena) centro.add(nc.pos);
    centro.multiplyScalar(1 / this.nosCena.length);
    let raio = 1;
    for (const nc of this.nosCena) raio = Math.max(raio, nc.pos.distanceTo(centro));
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspecto = Math.max(0.5, Math.min(1, this.camera.aspect));
    this.destino = { alvo: centro, distancia: (raio + 1.5) / Math.tan(fov / 2) / aspecto };
    this.girarSozinho = true;
  }

  /**
   * Aproxima (fator > 1) ou afasta. Com um ponto da tela, aproxima EM DIREÇÃO a ele
   * (como num mapa): o que está sob o mouse continua sob o mouse, e vira o novo centro do giro.
   */
  zoom(fator: number, naTela?: { x: number; y: number }) {
    const base = (this.destino?.alvo ?? this.alvo).clone();
    const dist = this.destino?.distancia ?? this.distancia;
    const nova = Math.max(2.5, Math.min(80, dist / fator));
    if (naTela) {
      const p = this.pontoNaTela(naTela.x, naTela.y);
      if (p) base.add(p.sub(base).multiplyScalar(1 - nova / dist));
    }
    this.destino = { alvo: base, distancia: nova };
    this.parado = 0;
    this.girarSozinho = false;
  }

  /** Arrasta a vista sem girar (botão direito, Shift ou dois dedos). */
  mover(dx: number, dy: number) {
    const h = this.canvas.clientHeight || 1;
    const porPixel = (2 * this.distancia * Math.tan((this.camera.fov * Math.PI) / 360)) / h;
    const direita = new this.THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const cima = new this.THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const delta = direita.multiplyScalar(-dx * porPixel).add(cima.multiplyScalar(dy * porPixel));
    this.alvo.add(delta);
    this.destino?.alvo.add(delta);
    this.parado = 0;
    this.girarSozinho = false;
  }

  /** Desloca o centro da vista em pixels (abrir espaço para o painel ou a folha do celular). */
  deslocar(x: number, y: number) {
    this.deslocamento = { x, y };
    this.medir();
  }

  destruir() {
    cancelAnimationFrame(this.quadro);
    this.ro.disconnect();
    this.io.disconnect();
    this.desligarControles();
    this.limparConteudo();
    this.poeiraFundo.geometry.dispose();
    (this.poeiraFundo.material as Tres.Material).dispose();
    for (const r of this.rotulos) r.el.remove();
    this.rotuloFoco.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── por dentro ──

  private limparConteudo() {
    for (const o of [...this.conteudo.children]) {
      this.conteudo.remove(o);
      const obj = o as Tres.Points;
      obj.geometry?.dispose();
      (obj.material as Tres.Material | undefined)?.dispose();
    }
    this.geoNos = this.geoLinhas = this.geoPulsos = null;
  }

  private medir() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.deslocamento.x || this.deslocamento.y) this.camera.setViewOffset(w, h, this.deslocamento.x, this.deslocamento.y, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.uniforms.uAlturaTela.value = h;
  }

  private mostrarRotuloFoco(id: string | null) {
    const nc = id ? this.porId.get(id) : undefined;
    if (!nc || nc.no.categoria === "area") {
      this.rotuloFoco.hidden = true;
      return;
    }
    this.rotuloFoco.replaceChildren();
    if (nc.no.codigo) {
      const b = document.createElement("b");
      b.textContent = nc.no.codigo;
      this.rotuloFoco.append(b);
    }
    const s = document.createElement("span");
    s.textContent = nc.no.rotulo;
    this.rotuloFoco.append(s);
    this.rotuloFoco.dataset.id = nc.no.id;
    this.rotuloFoco.hidden = false;
  }

  /** O nó mais perto do ponteiro (em pixels), se estiver perto o bastante. */
  private noEm(x: number, y: number): string | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    let melhor: string | null = null;
    let menor = 18;
    for (const nc of this.nosCena) {
      this.v.copy(nc.pos).applyMatrix4(this.mundo.matrixWorld).project(this.camera);
      if (this.v.z > 1) continue;
      const sx = (this.v.x * 0.5 + 0.5) * w;
      const sy = (-this.v.y * 0.5 + 0.5) * h;
      const d = Math.hypot(sx - x, sy - y) - (nc.no.categoria === "area" ? 6 : 0);
      if (d < menor) {
        menor = d;
        melhor = nc.no.id;
      }
    }
    return melhor;
  }

  /** Onde o ponto da tela cai no plano que passa pelo centro atual da vista (de frente para a câmera). */
  private pontoNaTela(x: number, y: number): Tres.Vector3 | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return null;
    const T = this.THREE;
    const longe = new T.Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5).unproject(this.camera);
    const origem = this.camera.position.clone();
    const dir = longe.sub(origem).normalize();
    const frente = new T.Vector3();
    this.camera.getWorldDirection(frente);
    const den = dir.dot(frente);
    if (Math.abs(den) < 1e-4) return null;
    const t = this.alvo.clone().sub(origem).dot(frente) / den;
    return t > 0 ? origem.add(dir.multiplyScalar(t)) : null;
  }

  private local(e: PointerEvent | WheelEvent | MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private aoBaixar = (e: PointerEvent) => {
    this.canvas.setPointerCapture(e.pointerId);
    this.toques.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.toques.size === 1) {
      this.arraste = { x: e.clientX, y: e.clientY, moveu: 0 };
      this.modoArraste = e.button === 1 || e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey ? "mover" : "girar";
      this.canvas.style.cursor = this.modoArraste === "mover" ? "move" : "grabbing";
    } else {
      this.arraste = null;
      this.meioToques = null;
    }
    this.parado = 0;
  };

  private aoMover = (e: PointerEvent) => {
    if (this.toques.has(e.pointerId)) this.toques.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.toques.size === 2) {
      // Dois dedos: pinça aproxima onde os dedos estão, e arrastar os dois move a vista.
      const [a, b] = [...this.toques.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const r = this.canvas.getBoundingClientRect();
      const meio = { x: (a!.x + b!.x) / 2 - r.left, y: (a!.y + b!.y) / 2 - r.top };
      if (this.meioToques) this.mover(meio.x - this.meioToques.x, meio.y - this.meioToques.y);
      if (this.pinca) this.zoom(d / this.pinca, meio);
      this.pinca = d;
      this.meioToques = meio;
      return;
    }
    if (this.arraste) {
      const dx = e.clientX - this.arraste.x;
      const dy = e.clientY - this.arraste.y;
      this.arraste.moveu += Math.abs(dx) + Math.abs(dy);
      this.girarSozinho = false;
      if (this.modoArraste === "mover") this.mover(dx, dy);
      else {
        this.yaw -= dx * 0.006;
        this.pitch = Math.max(-1.25, Math.min(1.25, this.pitch + dy * 0.005));
      }
      this.arraste.x = e.clientX;
      this.arraste.y = e.clientY;
      this.parado = 0;
      return;
    }
    if (e.pointerType === "mouse") {
      const { x, y } = this.local(e);
      const id = this.noEm(x, y);
      if (id !== this.apontado) {
        this.apontado = id;
        this.canvas.style.cursor = id ? "pointer" : "grab";
        this.eventos.apontou(id);
      }
    }
  };

  private aoSoltar = (e: PointerEvent) => {
    const clique = this.arraste && this.arraste.moveu < 6 && this.toques.size === 1;
    this.toques.delete(e.pointerId);
    if (this.toques.size < 2) {
      this.pinca = null;
      this.meioToques = null;
    }
    this.canvas.style.cursor = this.apontado ? "pointer" : "grab";
    if (clique) {
      const { x, y } = this.local(e);
      this.eventos.clicou(this.noEm(x, y));
    }
    this.arraste = null;
  };

  private aoSair = () => {
    if (this.apontado) {
      this.apontado = null;
      this.eventos.apontou(null);
    }
  };

  private aoRolar = (e: WheelEvent) => {
    e.preventDefault();
    // Trackpad manda passos pequenos; a roda do mouse, grandes. O zoom acompanha os dois.
    const passo = Math.max(-1, Math.min(1, -e.deltaY / (e.deltaMode === 1 ? 3 : 100)));
    this.zoom(Math.pow(1.18, passo), this.local(e));
  };

  /** Duplo clique: abre o registro sob o mouse, ou aproxima ali. */
  private aoDuploClique = (e: MouseEvent) => {
    const { x, y } = this.local(e);
    const id = this.noEm(x, y);
    if (id) this.eventos.clicou(id);
    else this.zoom(2, { x, y });
  };

  private semMenu = (e: Event) => e.preventDefault();

  private ligarControles() {
    const c = this.canvas;
    c.style.touchAction = "none";
    c.style.cursor = "grab";
    c.addEventListener("pointerdown", this.aoBaixar);
    c.addEventListener("pointermove", this.aoMover);
    c.addEventListener("pointerup", this.aoSoltar);
    c.addEventListener("pointercancel", this.aoSoltar);
    c.addEventListener("pointerleave", this.aoSair);
    c.addEventListener("wheel", this.aoRolar, { passive: false });
    c.addEventListener("dblclick", this.aoDuploClique);
    c.addEventListener("contextmenu", this.semMenu);
  }

  private desligarControles() {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.aoBaixar);
    c.removeEventListener("pointermove", this.aoMover);
    c.removeEventListener("pointerup", this.aoSoltar);
    c.removeEventListener("pointercancel", this.aoSoltar);
    c.removeEventListener("pointerleave", this.aoSair);
    c.removeEventListener("wheel", this.aoRolar);
    c.removeEventListener("dblclick", this.aoDuploClique);
    c.removeEventListener("contextmenu", this.semMenu);
  }

  private animar = (agora: number) => {
    this.quadro = requestAnimationFrame(this.animar);
    const dt = Math.min(0.05, (agora - this.antes) / 1000);
    this.antes = agora;
    if (!this.visivel || document.hidden) return;
    this.parado += dt;
    if (this.movimento) this.uniforms.uT.value += dt;
    // Gira devagar sozinho quando ninguém mexe.
    if (this.movimento && this.girarSozinho && !this.arraste && this.parado > 2.5 && !this.destino) this.yaw += dt * 0.05;
    if (this.destino) {
      const k = this.movimento ? Math.min(1, dt * 3.2) : 1;
      this.alvo.lerp(this.destino.alvo, k);
      this.distancia += (this.destino.distancia - this.distancia) * k;
      if (this.alvo.distanceTo(this.destino.alvo) < 0.01 && Math.abs(this.distancia - this.destino.distancia) < 0.02) this.destino = null;
    }
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.alvo.x + Math.sin(this.yaw) * cp * this.distancia,
      this.alvo.y + Math.sin(this.pitch) * this.distancia,
      this.alvo.z + Math.cos(this.yaw) * cp * this.distancia,
    );
    this.camera.lookAt(this.alvo);
    this.poeiraFundo.rotation.y += dt * 0.004;
    this.renderer.render(this.cena, this.camera);
    this.posicionarRotulos();
  };

  private posicionarRotulos() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const colocar = (el: HTMLElement, p: Tres.Vector3) => {
      this.v.copy(p).applyMatrix4(this.mundo.matrixWorld).project(this.camera);
      const fora = this.v.z > 1 || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2;
      el.style.transform = `translate(${((this.v.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-this.v.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
      return fora;
    };
    for (const r of this.rotulos) {
      const fora = colocar(r.el, r.alvo.pos);
      const longe = this.camera.position.distanceTo(r.alvo.pos);
      r.el.style.opacity = fora ? "0" : String(Math.max(0.3, Math.min(1, 1.5 - (longe - this.distancia + 3) / 10)));
    }
    if (!this.rotuloFoco.hidden) {
      const nc = this.porId.get(this.rotuloFoco.dataset.id ?? "");
      if (nc) this.rotuloFoco.style.opacity = colocar(this.rotuloFoco, nc.pos) ? "0" : "1";
    }
  }
}
