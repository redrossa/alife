"use client";

import { useEffect, useRef } from "react";

const vertex = `attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

// Original procedural height field. Contour width is estimated from adjacent pixels
// so it remains readable without requiring the derivatives WebGL extension.
const fragment = `precision highp float;
uniform vec2 resolution;
uniform float night;
uniform float travel;
uniform float starTravel;
uniform float starSpeed;
uniform vec2 pointer;
uniform vec3 pageColor;
float starHash(vec2 p) {
  return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);
}
float starsAt(vec2 pixel) {
  // Three staggered depth layers expand from the horizon while travelling.
  // Crossfades hide recycling; the same travel coordinate retraces the same stars.
  vec2 grid=vec2(48.0,30.0);
  vec2 uv=pixel/resolution;
  vec2 center=vec2(0.5,0.52);
  // Pointer-driven sparkle: every star has a random drift slot, and moving the
  // cursor sweeps the sky, igniting whichever few stars it crosses. Nothing
  // twinkles on its own; the field holds still until the pointer moves.
  float sweep=pointer.x*1.4+pointer.y*0.9;
  float stars=0.0;
  for(int layer=0;layer<3;layer++) {
    float phase=fract(starTravel*0.018+float(layer)/3.0);
    float scale=exp2(phase*2.0);
    float fade=smoothstep(0.0,0.18,phase)*(1.0-smoothstep(0.78,1.0,phase));
    vec2 field=(uv-center)/scale+center;
    vec2 cell=floor(field*grid);
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
      vec2 id=cell+vec2(float(x),float(y));
      vec2 key=id+float(layer)*vec2(73.1,119.7);
      float seed=starHash(key);
      if(seed>0.34) continue;
      vec2 source=(id+vec2(starHash(key+0.13),starHash(key+0.71)))/grid;
      vec2 pos=center+(source-center)*scale;
      vec2 delta=(uv-pos)*resolution;
      vec2 direction=normalize((pos-center)*resolution+vec2(0.0001));
      float trail=min(abs(starSpeed)*0.45,12.0)*phase;
      // Short radial capsules read as motion blur, not random dot jitter.
      float along=dot(delta,direction);
      delta-=direction*clamp(along,-trail*0.5,trail*0.5);
      float radius=mix(0.9,1.6,starHash(key+2.3))*mix(1.25,1.0,night);
      float falloff=length(delta);
      // Crisp core plus soft halo: the neon point-light shape.
      float core=1.0-smoothstep(radius*mix(0.12,0.0,night),radius,falloff);
      float halo=1.0-smoothstep(radius,radius*3.4,falloff);
      // Wide brightness spread: most stars stay faint, a few are much brighter.
      float brightness=mix(0.16,1.0,pow(seed/0.34,2.0));
      // Each star flares when the pointer sweep crosses its own phase, with its
      // own amplitude, so a mouse move lights a scattered handful at a time.
      float glint=pow(max(0.0,sin((sweep+starHash(key+3.7)*4.0)*3.14159)),16.0)
                 *mix(0.5,2.2,starHash(key+5.9));
      stars+=core*brightness*(1.0+glint*2.2)*fade;
      stars+=halo*mix(0.05,0.22,night)*(0.5+0.5*brightness)*(1.0+glint*0.8)*fade;
    }
  }
  return stars*smoothstep(0.50,0.72,uv.y);
}
float heightAt(vec2 p) {
  return 0.52*sin(p.x*0.37 + sin(p.y*0.24)*1.4)
       + 0.38*cos(p.y*0.39 - p.x*0.18)
       + 0.19*sin(p.x*0.71+p.y*0.53)
       + 0.08*cos(p.x*1.17-p.y*0.64);
}
vec3 rayAt(vec2 pixel) {
  vec2 uv=(pixel*2.0-resolution)/resolution.y;
  return normalize(vec3(uv.x*0.70, uv.y*0.70-0.10, 1.5));
}
void main() {
  vec3 background=pageColor;
  vec3 color=background;
  float cameraZ = -5.0 + travel;
  // Follow the broad terrain elevation without descending into nearby hills.
  vec3 origin=vec3(1.0,3.1 + heightAt(vec2(1.0,cameraZ))*0.35,cameraZ);
  vec3 ray=rayAt(gl_FragCoord.xy);
  float t=0.0;
  bool hit=false;
  if(ray.y < 0.09) {
    for(int i=0;i<120;i++) {
      vec3 p=origin+ray*t;
      float gap=p.y-heightAt(p.xz);
      if(gap<0.002) {hit=true;break;}
      t+=max(0.018,gap*0.75);
      if(t>95.0) break;
    }
  }
  if(hit) {
    vec3 p=origin+ray*t;
    float h=heightAt(p.xz);
    float e=0.015;
    vec3 n=normalize(vec3(heightAt(p.xz-vec2(e,0.0))-heightAt(p.xz+vec2(e,0.0)),2.0*e,
                         heightAt(p.xz-vec2(0.0,e))-heightAt(p.xz+vec2(0.0,e))));
    float diffuse=max(0.0,dot(n,normalize(vec3(-0.5,0.9,-0.3))));
    vec3 ground=mix(vec3(0.89,0.885,0.875)+diffuse*0.055,
                    vec3(0.067,0.061,0.075)+diffuse*0.018,night);
    // Differential tangent-plane intersections estimate screen-space line width.
    vec3 rx=rayAt(gl_FragCoord.xy+vec2(1.0,0.0));
    vec3 ry=rayAt(gl_FragCoord.xy+vec2(0.0,1.0));
    float plane=dot(p-origin,n);
    vec3 px=origin+rx*(plane/min(dot(rx,n),-0.001));
    vec3 py=origin+ry*(plane/min(dot(ry,n),-0.001));
    float frequency=13.0;
    float footprint=max(0.012,(abs(px.y-p.y)+abs(py.y-p.y))*frequency);
    float contourDistance=abs(fract(h*frequency+0.5)-0.5);
    float line=1.0-smoothstep(footprint*0.20,footprint*0.85,contourDistance);
    float mask=1.0-smoothstep(0.22,0.75,footprint);
    line*=mask;
    // Wider soft halo around each line; night layers an additive bloom on top.
    float halo=(1.0-smoothstep(footprint*0.85,footprint*3.0,contourDistance))*mask;
    // Header orb palette extended with a deep blue stop. The ramp wraps through
    // the same lavender at both ends, so the flowing gradient loops seamlessly.
    // The band phase lives in world space and rides the height field, so color
    // is anchored to the ground and bends around the waves. The pointer nudges
    // the phase instead of time, so moving the cursor sweeps the palette across
    // the landscape and it holds still otherwise.
    float gradient=fract(p.x*0.045+p.z*0.015+h*0.28+pointer.x*0.40-pointer.y*0.28);
    vec3 lavender=vec3(0.705882,0.549020,1.0);   // #b48cff
    vec3 violet=vec3(0.560784,0.360784,1.0);     // #8f5cff
    vec3 blue=vec3(0.290196,0.454902,1.0);       // #4a74ff
    vec3 periwinkle=vec3(0.427451,0.607843,1.0); // #6d9bff
    vec3 ink=gradient<0.25
      ? mix(lavender,violet,gradient/0.25)
      : gradient<0.50
      ? mix(violet,blue,(gradient-0.25)/0.25)
      : gradient<0.75
      ? mix(blue,periwinkle,(gradient-0.50)/0.25)
      : mix(periwinkle,lavender,(gradient-0.75)/0.25);
    float strength=mix(0.56,0.38,night);
    ground=mix(ground,ink,line*strength);
    ground=mix(ground,ink,halo*mix(0.15,0.10,night));
    ground+=ink*halo*halo*mix(0.0,0.07,night);
    float visibility=exp(-t*0.035);
    // No sharp horizon; far hills dissolve into the same blank page color.
    visibility*=1.0-smoothstep(45.0,90.0,t);
    color=mix(background,ground,visibility);
  }
  if(!hit) {
    float stars=starsAt(gl_FragCoord.xy);
    // Pale sky uses vivid violet points; dark sky uses luminous neon white.
    vec3 starTint=mix(vec3(0.47,0.38,0.82),vec3(0.95,0.94,1.0),night);
    float starOpacity=clamp(stars*mix(2.6,1.55,night),0.0,1.0);
    color=mix(color,starTint,starOpacity);
  }
  gl_FragColor=vec4(color,1.0);
}`;

export default function TerrainBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let currentTravel = 0;
    let targetTravel = 0;
    let cleanup: (() => void) | undefined;
    function initialize() {
      if (!canvas) return;
      const gl = canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, powerPreference: "low-power" });
      if (!gl) return;
      const shaders: WebGLShader[] = [];
      let program: WebGLProgram | null = null;
      let buffer: WebGLBuffer | null = null;
      let scheduled = 0;
      let lost = false;
      const release = () => {
        gl.deleteBuffer(buffer);
        gl.deleteProgram(program);
        shaders.forEach(s => gl.deleteShader(s));
      };
      try {
        for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
          const shader = gl.createShader(type);
          if (!shader) throw new Error("Shader unavailable");
          shaders.push(shader);
          gl.shaderSource(shader, source);
          gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Compilation failed");
        }
        program = gl.createProgram();
        if (!program) throw new Error("Program unavailable");
        shaders.forEach(s => gl.attachShader(program!, s));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Link failed");
        gl.useProgram(program);
        buffer = gl.createBuffer();
        if (!buffer) throw new Error("Buffer unavailable");
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "position");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
      } catch (error) {
        console.warn("Terrain background unavailable:", error);
        release();
        return;
      }
      const resolution = gl.getUniformLocation(program, "resolution");
      const night = gl.getUniformLocation(program, "night");
      const travel = gl.getUniformLocation(program, "travel");
      const starTravel = gl.getUniformLocation(program, "starTravel");
      const starSpeed = gl.getUniformLocation(program, "starSpeed");
      const pointer = gl.getUniformLocation(program, "pointer");
      const pageColor = gl.getUniformLocation(program, "pageColor");
      // The canvas paints an opaque background, so resolve the page color from
      // CSS (whatever syntax the minifier emits) instead of hardcoding it.
      let pageBackground = [1, 1, 1];
      function refreshBackground() {
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;color:var(--background)";
        document.body.appendChild(probe);
        const resolved = getComputedStyle(probe).color;
        probe.remove();
        const match = /^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(resolved);
        if (!match) return;
        pageBackground = [
          Number(match[1]) / 255,
          Number(match[2]) / 255,
          Number(match[3]) / 255,
        ];
      }
      refreshBackground();
      let velocity = 0;
      // Pointer phases are eased toward the latest cursor position, so mousemove
      // batching stays smooth and the palette settles when the cursor rests.
      const pointerCurrent = [0, 0];
      const pointerTarget = [0, 0];
      let lastFrame = 0;
      let touchY: number | null = null;
      function draw() {
        if (!canvas || !gl || lost) return;
        const scale = Math.min(devicePixelRatio || 1, 2, 2200/innerWidth, 1500/innerHeight);
        const width = Math.max(1, Math.round(innerWidth*scale));
        const height = Math.max(1, Math.round(innerHeight*scale));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        gl.viewport(0,0,canvas.width,canvas.height);
        gl.uniform2f(resolution,canvas.width,canvas.height);
        const selectedTheme = document.documentElement.dataset.theme;
        gl.uniform1f(night, (selectedTheme ? selectedTheme === "dark" : theme.matches) ? 1 : 0);
        gl.uniform1f(travel,currentTravel);
        gl.uniform1f(starTravel,currentTravel * (reduced.matches ? 0.15 : 1));
        gl.uniform1f(starSpeed,velocity * (reduced.matches ? 0.15 : 1));
        gl.uniform2f(pointer, pointerCurrent[0], pointerCurrent[1]);
        gl.uniform3f(pageColor, pageBackground[0], pageBackground[1], pageBackground[2]);
        gl.drawArrays(gl.TRIANGLES,0,3);
        canvas.dataset.ready="true";
      }
      function tick(now: number) {
        scheduled = 0;
        if (lost || document.hidden) { lastFrame = 0; return; }
        const dt = lastFrame ? Math.min((now-lastFrame)/1000,0.05) : 1/60;
        lastFrame = now;
        const difference = targetTravel-currentTravel;
        const previousTravel = currentTravel;
        currentTravel += difference * (1-Math.exp(-dt*7));
        if (Math.abs(targetTravel-currentTravel)<0.001) currentTravel=targetTravel;
        velocity = currentTravel === targetTravel ? 0 : (currentTravel-previousTravel)/dt;
        for (let axis=0; axis<2; axis++) {
          const step = (pointerTarget[axis]-pointerCurrent[axis]) * (1-Math.exp(-dt*10));
          pointerCurrent[axis] += step;
          if (Math.abs(pointerTarget[axis]-pointerCurrent[axis])<0.001) pointerCurrent[axis]=pointerTarget[axis];
        }
        draw();
        // Nothing moves on its own: the loop parks once travel has settled and
        // the palette has caught up with the cursor.
        if (currentTravel!==targetTravel
            || pointerCurrent[0]!==pointerTarget[0]
            || pointerCurrent[1]!==pointerTarget[1]) scheduled=requestAnimationFrame(tick);
        else lastFrame=0;
      }
      function schedule() {
        if (!scheduled && !lost && !document.hidden) scheduled=requestAnimationFrame(tick);
      }
      function onThemeChange() {
        refreshBackground();
        schedule();
      }
      function acceptsInput(target: EventTarget | null) {
        return !(target instanceof Element && target.closest('a, button, input, textarea, select, [contenteditable="true"], [role="dialog"]'));
      }
      function move(delta: number) {
        // Bounded input bursts, but no endpoints: reverse scrolling retraces the same landscape.
        targetTravel += Math.max(-240,Math.min(240,delta))*0.012;
        schedule();
      }
      function preventBoundaryScroll(event: WheelEvent | TouchEvent, delta: number) {
        const root = document.scrollingElement;
        if (!root || !event.cancelable) return;
        const maxScroll = Math.max(0, root.scrollHeight-root.clientHeight);
        // Preserve access to overflowing content, but never hand an outward
        // gesture to the browser's elastic viewport (including mobile Safari).
        if (maxScroll<=1 || (delta<0 && root.scrollTop<=0) || (delta>0 && root.scrollTop>=maxScroll-1)) {
          event.preventDefault();
        }
      }
      function wheel(event: WheelEvent) {
        if (event.ctrlKey || event.metaKey || !acceptsInput(event.target)) return;
        const pixels=event.deltaY*(event.deltaMode===1 ? 16 : event.deltaMode===2 ? innerHeight : 1);
        preventBoundaryScroll(event,pixels);
        move(pixels);
      }
      function touchStart(event: TouchEvent) {
        touchY=event.touches.length===1 && acceptsInput(event.target) ? event.touches[0].clientY : null;
      }
      function touchMove(event: TouchEvent) {
        if (touchY===null || event.touches.length!==1) { touchY=null; return; }
        const y=event.touches[0].clientY;
        const delta=touchY-y;
        preventBoundaryScroll(event,delta);
        move(delta);
        touchY=y;
      }
      function touchEnd() { touchY=null; }
      function pointerMove(event: PointerEvent) {
        // Touch drags already travel the terrain; only a mouse or pen steers
        // the palette with its position.
        if (event.pointerType === "touch") return;
        pointerTarget[0] = Math.max(-1,Math.min(1,(event.clientX/innerWidth)*2-1));
        pointerTarget[1] = Math.max(-1,Math.min(1,1-(event.clientY/innerHeight)*2));
        schedule();
      }
      function visibility() {
        if (document.hidden) { cancelAnimationFrame(scheduled); scheduled=0; lastFrame=0; }
        else schedule();
      }
      function onLost(event: Event) {
        event.preventDefault(); lost=true;
        cancelAnimationFrame(scheduled);
        canvas?.removeAttribute("data-ready");
      }
      function onRestored() { cleanup?.(); initialize(); }
      draw();
      window.addEventListener("resize",schedule);
      window.addEventListener("pointermove",pointerMove,{passive:true});
      window.addEventListener("wheel",wheel,{passive:false});
      window.addEventListener("touchstart",touchStart,{passive:true});
      window.addEventListener("touchmove",touchMove,{passive:false});
      window.addEventListener("touchend",touchEnd);
      window.addEventListener("touchcancel",touchEnd);
      document.addEventListener("visibilitychange",visibility);
      theme.addEventListener("change",onThemeChange);
      window.addEventListener("alife-theme-change",onThemeChange);
      reduced.addEventListener("change",schedule);
      canvas.addEventListener("webglcontextlost",onLost);
      canvas.addEventListener("webglcontextrestored",onRestored);
      cleanup=()=>{
        cancelAnimationFrame(scheduled);
        window.removeEventListener("resize",schedule);
        window.removeEventListener("pointermove",pointerMove);
        window.removeEventListener("wheel",wheel);
        window.removeEventListener("touchstart",touchStart);
        window.removeEventListener("touchmove",touchMove);
        window.removeEventListener("touchend",touchEnd);
        window.removeEventListener("touchcancel",touchEnd);
        document.removeEventListener("visibilitychange",visibility);
        theme.removeEventListener("change",onThemeChange);
        window.removeEventListener("alife-theme-change",onThemeChange);
        reduced.removeEventListener("change",schedule);
        canvas.removeEventListener("webglcontextlost",onLost);
        canvas.removeEventListener("webglcontextrestored",onRestored);
        canvas.removeAttribute("data-ready");
        release();
      };
    }
    initialize();
    return ()=>cleanup?.();
  },[]);
  return <div className="terrain-background" aria-hidden="true"><canvas ref={ref}/></div>;
}
