// The table: an original domain-warped "paint swirl" shader, rendered at a
// fraction of the window size and upscaled with nearest-neighbour filtering,
// so it reads as chunky pixel paint. Palettes cross-fade between states.

import { motion } from './motion';

type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export const PALETTES: Record<string, [RGB, RGB, RGB]> = {
  video: [hex('#140c10'), hex('#8a2219'), hex('#1b5d61')],
  audio: [hex('#0a0f22'), hex('#2b3fae'), hex('#6a2a8f')],
  success: [hex('#0d1a10'), hex('#1f8a52'), hex('#b8901a')],
  error: [hex('#1a0606'), hex('#b0211a'), hex('#4a1a2a')],
  engine: [hex('#0e1215'), hex('#5a4a22'), hex('#1d4d57')],
};

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_spin;
uniform float u_flash;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float t = u_time;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  // Spiral arms: the twist grows toward the middle and slowly drifts.
  a += u_spin * 0.55 * (1.6 / (0.35 + r)) + t * 0.06;
  vec2 p = vec2(cos(a), sin(a)) * r * 3.4;
  // Domain warp: fold the plane onto itself.
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    p += vec2(sin(p.y * 1.4 + t * 0.30 + fi * 1.7), cos(p.x * 1.3 - t * 0.25 + fi * 2.3)) * 0.42;
  }
  // Two interfering paint layers.
  float f1 = sin(p.x * 1.1 + p.y * 0.9 + t * 0.30);
  float f2 = sin(length(p) * 1.4 - t * 0.20 + a * 2.0);
  float v = 0.5 + 0.25 * f1 + 0.25 * f2;
  vec3 col = mix(u_c0, u_c1, smoothstep(0.28, 0.72, v));
  col = mix(col, u_c2, smoothstep(0.60, 0.95, 0.5 + 0.5 * f2) * 0.85);
  // A bright ridge where the layers meet.
  col += vec3(0.07) * (1.0 - smoothstep(0.0, 0.035, abs(v - 0.5)));
  // Posterize: painted, pixel-art bands.
  col = floor(col * 12.0 + 0.5) / 12.0;
  col *= 1.0 - smoothstep(0.5, 1.5, r) * 0.6;
  col += u_flash * vec3(0.32, 0.28, 0.18);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Background {
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private loc: Record<string, WebGLUniformLocation | null> = {};
  private time = 0;
  private last = 0;
  private raf = 0;
  private spin = 1.4;
  private spinTarget = 1.4;
  private speed = 1;
  private speedTarget = 1;
  private flash = 0;
  private colors: [RGB, RGB, RGB] = PALETTES.video.map((c) => [...c] as RGB) as [RGB, RGB, RGB];
  private target: [RGB, RGB, RGB] = PALETTES.video;
  private paused = false;
  enabled = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
    if (!this.gl) {
      canvas.style.background = 'radial-gradient(circle at 40% 40%, #5a1b16, #0b1418 70%)';
      return;
    }
    this.init();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      this.paused = document.hidden;
      if (!this.paused) this.loop(performance.now());
    });
    this.loop(performance.now());
  }

  private init(): void {
    const gl = this.gl!;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const u of ['u_res', 'u_time', 'u_spin', 'u_flash', 'u_c0', 'u_c1', 'u_c2']) this.loc[u] = gl.getUniformLocation(prog, u);
    this.prog = prog;
  }

  private resize(): void {
    // Quarter resolution → big soft pixels; cheap on laptops.
    const scale = 0.25;
    const w = Math.max(64, Math.round(window.innerWidth * scale));
    const h = Math.max(64, Math.round(window.innerHeight * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl?.viewport(0, 0, w, h);
    }
  }

  setPalette(name: keyof typeof PALETTES): void {
    this.target = PALETTES[name] ?? PALETTES.video;
    if (motion.frozen) {
      this.colors = this.target.map((c) => [...c] as RGB) as [RGB, RGB, RGB];
      this.draw();
    }
  }

  /** Energy: 0 calm … 1 shuffling/downloading … 2 jackpot. */
  setEnergy(e: number): void {
    this.speedTarget = 1 + e * 1.8;
    this.spinTarget = 1.4 + e * 0.9;
  }

  pulse(amount = 0.6): void {
    this.flash = Math.min(1, this.flash + amount);
  }

  /** Freeze on a fixed frame (screenshots). */
  freezeAt(t: number): void {
    this.time = t;
    this.colors = this.target.map((c) => [...c] as RGB) as [RGB, RGB, RGB];
    this.flash = 0;
    this.spin = this.spinTarget;
    this.draw();
  }

  private loop = (now: number) => {
    if (this.paused || !this.gl) return;
    const dt = Math.min(0.1, (now - this.last) / 1000 || 0);
    this.last = now;
    if (!motion.frozen) {
      const live = this.enabled && !motion.reduced;
      const k = 1 - Math.pow(0.04, dt);
      this.speed += (this.speedTarget - this.speed) * k;
      this.spin += (this.spinTarget - this.spin) * k;
      this.time += dt * (live ? this.speed : 0.08) * motion.timeScale;
      this.flash = Math.max(0, this.flash - dt * 1.6);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) this.colors[i][j] += (this.target[i][j] - this.colors[i][j]) * Math.min(1, dt * 2.2);
      this.draw();
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.uniform2f(this.loc.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.loc.u_time, this.time);
    gl.uniform1f(this.loc.u_spin, this.spin);
    gl.uniform1f(this.loc.u_flash, this.flash);
    gl.uniform3fv(this.loc.u_c0, this.colors[0]);
    gl.uniform3fv(this.loc.u_c1, this.colors[1]);
    gl.uniform3fv(this.loc.u_c2, this.colors[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }
}
