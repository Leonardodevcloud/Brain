/**
 * Nebulosa: nuvem de partículas em espiral, desenhada na placa de vídeo (Three.js).
 * É a esfera do Argos e o fundo da tela de entrada. As partículas somam luz (blending aditivo),
 * o que dá o brilho de "holograma"; o movimento é calculado no shader, sem custo no processador.
 */
import type * as Tres from "three";

export type ModuloThree = typeof Tres;

/** O que a nebulosa lê a cada quadro (0–1). */
export interface SinaisNebulosa {
  /** Volume da voz (do microfone ou da fala do Argos). */
  nivel: number;
  /** Pensando: gira mais rápido e agita. */
  pensar: number;
  /** Ouvindo: respira de leve. */
  ouvir: number;
  /** Erro: puxa a cor para o vermelho. */
  erro: number;
}

export interface OpcoesNebulosa {
  particulas: number;
  /** Estrelas soltas ao redor (fundo da tela de entrada). */
  poeira?: number;
  /** Multiplica o tamanho dos pontos (esferas pequenas precisam de pontos maiores). */
  ponto?: number;
  /** Gira um pouco seguindo o mouse. */
  seguirMouse?: boolean;
  /** Posição da nuvem na tela (-1 a 1), para não ficar atrás de um texto. */
  centro?: { x: number; y: number };
  /** Raio da nuvem em relação à altura da tela (padrão: cabe inteira). */
  escala?: number;
  movimento: boolean;
}

const RUIDO = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const FRAG_PONTO = /* glsl */ `
varying vec3 vCor; varying float vAlfa;
void main(){
  vec2 c=gl_PointCoord-.5; float d=length(c);
  float nucleo=smoothstep(.5,.0,d); float halo=smoothstep(.5,.15,d)*.35;
  gl_FragColor=vec4(vCor*(nucleo+halo),(nucleo*.9+halo)*vAlfa);
}`;

const VERT_NUVEM = /* glsl */ `
${RUIDO}
uniform float uT,uNivel,uPensar,uOuvir,uErro,uEscala;
attribute float aSem; varying vec3 vCor; varying float vAlfa;
void main(){
  float r=length(position);
  float giro=uT*(.25+uPensar*1.4)*(1.6-r*.6);
  float c=cos(giro), s=sin(giro);
  vec3 p=vec3(position.x*c-position.z*s, position.y, position.x*s+position.z*c);
  vec3 desvio=vec3(snoise(p*1.3+uT*.3),snoise(p*1.3+11.+uT*.3),snoise(p*1.3+23.+uT*.3));
  p+=desvio*(.08+uPensar*.06);
  p*=1.+uNivel*.28*smoothstep(.3,1.3,r)+uOuvir*.025*sin(uT*2.6+aSem*6.28);
  vec4 mv=modelViewMatrix*vec4(p,1.);
  vec3 cor=mix(vec3(1.,.45,.85),vec3(.55,.4,1.),smoothstep(.2,1.3,r));
  cor=mix(cor,vec3(.9,.85,1.),(1.-smoothstep(0.,.45,r))*.8);
  vCor=mix(cor,vec3(1.,.35,.4),uErro*.85);
  vAlfa=.28+.5*(1.-smoothstep(.2,1.4,r))+uNivel*.2;
  gl_PointSize=(1.1+aSem*1.9)*uEscala*(9./-mv.z);
  gl_Position=projectionMatrix*mv;
}`;

const VERT_POEIRA = /* glsl */ `
uniform float uT,uEscala; attribute float aSem; varying vec3 vCor; varying float vAlfa;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.);
  vCor=mix(vec3(.75,.7,1.),vec3(.95,.7,1.),aSem);
  vAlfa=.25+.35*(.5+.5*sin(uT*(.6+aSem*1.5)+aSem*40.));
  gl_PointSize=(.8+aSem*1.4)*uEscala*(9./-mv.z);
  gl_Position=projectionMatrix*mv;
}`;

export const webglDisponivel = () => {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
};

/** Monta a nebulosa no canvas e começa a animar. Devolve a função que desmonta tudo. */
export function criarNebulosa(THREE: ModuloThree, canvas: HTMLCanvasElement, opcoes: OpcoesNebulosa, sinais: () => SinaisNebulosa): () => void {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  const razao = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(razao);
  renderer.setClearColor(0x000000, 0);
  const cena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 80);
  camera.position.set(0, 0, 6.2);
  const grupo = new THREE.Group();
  cena.add(grupo);

  // Nuvem: pontos numa bola, mais densa no centro.
  const n = opcoes.particulas;
  const pos = new Float32Array(n * 3);
  const sem = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const r = 1.35 * Math.pow(Math.random(), 0.35);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph) * 0.92;
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    sem[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSem", new THREE.BufferAttribute(sem, 1));
  const uniforms = {
    uT: { value: 0 },
    uNivel: { value: 0 },
    uPensar: { value: 0 },
    uOuvir: { value: 0 },
    uErro: { value: 0 },
    uEscala: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT_NUVEM,
    fragmentShader: FRAG_PONTO,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const nuvem = new THREE.Points(geo, mat);
  grupo.add(nuvem);

  // Poeira de estrelas (só quando pedida).
  let poeira: Tres.Points | null = null;
  const uPoeira = { uT: uniforms.uT, uEscala: { value: 1 } };
  if (opcoes.poeira) {
    const q = opcoes.poeira;
    const pp = new Float32Array(q * 3);
    const ps = new Float32Array(q);
    for (let i = 0; i < q; i++) {
      pp[i * 3] = (Math.random() - 0.5) * 22;
      pp[i * 3 + 1] = (Math.random() - 0.5) * 14;
      pp[i * 3 + 2] = -Math.random() * 14 + 2;
      ps[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pp, 3));
    g.setAttribute("aSem", new THREE.BufferAttribute(ps, 1));
    poeira = new THREE.Points(
      g,
      new THREE.ShaderMaterial({ uniforms: uPoeira, vertexShader: VERT_POEIRA, fragmentShader: FRAG_PONTO, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    cena.add(poeira);
  }

  const centro = opcoes.centro ?? { x: 0, y: 0 };
  function medir() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // A nuvem ocupa a mesma fração da altura em qualquer tamanho; "escala" aumenta ou diminui.
    const escala = opcoes.escala ?? 1;
    camera.position.z = 6.2 / escala;
    camera.updateProjectionMatrix();
    // Desloca a nuvem sem distorcer (em unidades da cena na distância da câmera).
    const meiaAltura = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
    grupo.position.set(centro.x * meiaAltura * camera.aspect, centro.y * meiaAltura, 0);
    // Pontos com o mesmo tamanho relativo que no protótipo (canvas de ~380 px).
    const base = (razao * h) / 380;
    uniforms.uEscala.value = Math.max(base * (opcoes.ponto ?? 1), razao * 0.55) * escala;
    uPoeira.uEscala.value = razao * Math.max(1, h / 500);
  }
  const ro = new ResizeObserver(medir);
  ro.observe(canvas);
  medir();

  let visivel = true;
  const io = new IntersectionObserver(([e]) => {
    visivel = Boolean(e?.isIntersecting);
  });
  io.observe(canvas);

  let mouse = { x: 0, y: 0 };
  const alvoMouse = { x: 0, y: 0 };
  const aoMover = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    alvoMouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    alvoMouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  if (opcoes.seguirMouse) window.addEventListener("pointermove", aoMover, { passive: true });

  let quadro = 0;
  let t = Math.random() * 20;
  let antes = performance.now();
  const suave = { nivel: 0, pensar: 0, ouvir: 0, erro: 0 };
  function animar(agora: number) {
    quadro = requestAnimationFrame(animar);
    const dt = Math.min(0.05, (agora - antes) / 1000);
    antes = agora;
    if (!visivel || document.hidden) return;
    const s = sinais();
    const k = Math.min(1, dt * 10);
    suave.nivel += (s.nivel - suave.nivel) * Math.min(1, dt * 16);
    suave.pensar += (s.pensar - suave.pensar) * Math.min(1, dt * 3);
    suave.ouvir += (s.ouvir - suave.ouvir) * k;
    suave.erro += (s.erro - suave.erro) * k;
    t += opcoes.movimento ? dt : dt * 0.15;
    uniforms.uT.value = t;
    uniforms.uNivel.value = opcoes.movimento ? suave.nivel : suave.nivel * 0.3;
    uniforms.uPensar.value = suave.pensar;
    uniforms.uOuvir.value = suave.ouvir;
    uniforms.uErro.value = suave.erro;
    nuvem.rotation.x = 0.35 + Math.sin(t * 0.3) * 0.08;
    if (opcoes.seguirMouse) {
      mouse = { x: mouse.x + (alvoMouse.x - mouse.x) * Math.min(1, dt * 2.5), y: mouse.y + (alvoMouse.y - mouse.y) * Math.min(1, dt * 2.5) };
      grupo.rotation.y = mouse.x * 0.35;
      grupo.rotation.x = mouse.y * 0.2;
      if (poeira) {
        poeira.position.x = -mouse.x * 0.35;
        poeira.position.y = mouse.y * 0.25;
      }
    }
    renderer.render(cena, camera);
  }
  quadro = requestAnimationFrame(animar);

  return () => {
    cancelAnimationFrame(quadro);
    ro.disconnect();
    io.disconnect();
    window.removeEventListener("pointermove", aoMover);
    geo.dispose();
    mat.dispose();
    if (poeira) {
      poeira.geometry.dispose();
      (poeira.material as Tres.Material).dispose();
    }
    renderer.dispose();
    renderer.forceContextLoss();
  };
}

let carregando: Promise<ModuloThree> | null = null;
/** Three.js só baixa quando uma nebulosa aparece pela primeira vez. */
export function carregarThree(): Promise<ModuloThree> {
  carregando ??= import("three").catch((e) => {
    carregando = null;
    throw e;
  });
  return carregando;
}
