"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface AdisyonShaderProps {
  className?: string;
  /** Speed of the wave animation. Default: 0.18 */
  speed?: number;
  /** 4-colour palette: [background, indigo, violet, purple]. Uses StudyMate AI colours by default. */
  colors?: [string, string, string, string];
}

function hexToVec3(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

const VERT = /* glsl */ `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform float u_time;
  uniform vec2  u_resolution;
  uniform vec2  u_mouse;
  uniform vec3  u_c0;
  uniform vec3  u_c1;
  uniform vec3  u_c2;
  uniform vec3  u_c3;
  uniform float u_speed;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0,0)), hash(i + vec2(1,0)), u.x),
      mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2  shift = vec2(100.0);
    mat2  rot   = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p  = rot * p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    vec2 mouse = (u_mouse / u_resolution - 0.5);
    mouse.y = -mouse.y;
    uv += mouse * 0.08;

    float t = u_time * u_speed;

    vec2 q = vec2(
      fbm(uv + vec2(0.0, 0.0)),
      fbm(uv + vec2(5.2, 1.3))
    );

    vec2 r = vec2(
      fbm(uv + 4.0 * q + vec2(1.7 + t * 0.15, 9.2)),
      fbm(uv + 4.0 * q + vec2(8.3 + t * 0.126, 2.8))
    );

    float f = fbm(uv + 4.0 * r);

    float wave1 = sin(uv.x * 3.0 + t * 1.2 + f * 4.0) * 0.5 + 0.5;
    float wave2 = sin(uv.y * 2.5 - t * 0.9 + r.x * 3.5) * 0.5 + 0.5;
    float wave3 = sin((uv.x + uv.y) * 2.0 + t * 0.7 + q.y * 4.0) * 0.5 + 0.5;

    vec3 col = mix(u_c0, u_c1, clamp(f * f * 2.0, 0.0, 1.0));
    col = mix(col, u_c2, clamp(wave1 * wave2 * 1.8, 0.0, 1.0));
    col = mix(col, u_c3, clamp(wave3 * wave1 * 1.2, 0.0, 1.0));

    float vignette = 1.0 - smoothstep(0.4, 1.4, length(uv));
    col *= vignette;
    col = pow(col, vec3(1.4)) * 0.75;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default function AdisyonShader({
  className,
  speed = 0.18,
  colors = ["#07090e", "#4f46e5", "#7c3aed", "#a855f7"],
}: AdisyonShaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
    if (!gl) return;

    function compile(type: number, src: string) {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, src);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS))
        console.error("Shader error:", gl!.getShaderInfoLog(s));
      return s;
    }

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
      gl.STATIC_DRAW
    );
    const aPosLoc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);

    const uTime  = gl.getUniformLocation(prog, "u_time");
    const uRes   = gl.getUniformLocation(prog, "u_resolution");
    const uMouse = gl.getUniformLocation(prog, "u_mouse");
    const uSpeed = gl.getUniformLocation(prog, "u_speed");
    const uC0    = gl.getUniformLocation(prog, "u_c0");
    const uC1    = gl.getUniformLocation(prog, "u_c1");
    const uC2    = gl.getUniformLocation(prog, "u_c2");
    const uC3    = gl.getUniformLocation(prog, "u_c3");

    const [c0, c1, c2, c3] = colors.map(hexToVec3);
    gl.uniform3fv(uC0, c0);
    gl.uniform3fv(uC1, c1);
    gl.uniform3fv(uC2, c2);
    gl.uniform3fv(uC3, c3);
    gl.uniform1f(uSpeed, speed);

    let mouse = { x: 0, y: 0 };
    const onMouseMove = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    window.addEventListener("mousemove", onMouseMove);

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width  = window.innerWidth  * dpr;
      canvas!.height = window.innerHeight * dpr;
      gl!.viewport(0, 0, canvas!.width, canvas!.height);
    }
    window.addEventListener("resize", resize);
    resize();

    const start = performance.now();
    let raf: number;
    function render() {
      const t = (performance.now() - start) * 0.001;
      gl!.uniform1f(uTime, t);
      gl!.uniform2f(uRes, canvas!.width, canvas!.height);
      gl!.uniform2f(
        uMouse,
        mouse.x * (canvas!.width  / window.innerWidth),
        mouse.y * (canvas!.height / window.innerHeight)
      );
      gl!.drawArrays(gl!.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(render);
    }
    render();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("resize", resize);
    };
  }, [speed, colors]);

  return (
    <canvas
      ref={canvasRef}
      className={cn("fixed inset-0 w-full h-full -z-10 pointer-events-none", className)}
    />
  );
}
