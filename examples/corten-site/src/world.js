// @ts-check
// World (world.rs): draws the plate the page sits on, one fragment shader over a fixed canvas,
// and says which layer the reader is in. The plate is a core sample: weathered patina where the
// page starts, the dense oxide under it, bare steel, and patina again on the far side, with the
// tagline stamped into the surface. It is drawn again only when the page scrolls, the pointer
// moves, a plate is struck or the window changes, so an idle page costs no GPU time.
// Without a GPU that can draw it at speed the page keeps the flat colors its stylesheet gives
// each layer (data-flat), and the gauge works the same.
/** @import { PlateStruck } from "corten/events" */
import { keep } from "corten";

const VERTEX = `#version 300 es
in vec2 aCorner;
void main() {
  gl_Position = vec4(aCorner, 0.0, 1.0);
}`;

// Every texture read names its level (textureLod), so none needs the screen's derivatives and
// a layer's branch is one the GPU can skip: a pixel pays for the layer it is in.
const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uCanvas;
uniform float uScale;
uniform float uScroll;
uniform vec2 uPointer;
uniform float uWeather;
uniform vec3 uStrata;
uniform vec3 uStruck;
uniform sampler2D uStamp;
uniform vec2 uStampSize;
uniform float uStampLod;
uniform sampler2D uNoise;
out vec4 color;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Value noise read from a sheet of random values, one filtered sample each: computed in the
// shader instead, this many octaves take a Direct3D compiler seconds, with the page frozen.
float noise(vec2 p) {
  vec2 f = fract(p);
  return textureLod(uNoise, (floor(p) + f * f * (3.0 - 2.0 * f) + 0.5) * (1.0 / 256.0), 0.0).r;
}

// Each octave is turned against the last, so the noise's grid never lines up into squares.
const mat2 TURN = mat2(0.8, -0.6, 0.6, 0.8);

float turned4(vec2 p) {
  float sum = 0.0;
  float gain = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += gain * noise(p);
    p = TURN * p * 2.03 + vec2(17.1, 9.2);
    gain *= 0.5;
  }
  return sum * 1.0667;
}

float turned3(vec2 p) {
  float sum = 0.0;
  float gain = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += gain * noise(p);
    p = TURN * p * 2.03 + vec2(17.1, 9.2);
    gain *= 0.5;
  }
  return sum * 1.143;
}

// Three octaves kept square to the plate: for streaks that run along it.
float square3(vec2 p) {
  float sum = 0.0;
  float gain = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += gain * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    gain *= 0.5;
  }
  return sum * 1.143;
}

// The surface's height, for the light: a fine tooth everywhere, and where the layer is rough
// (everything but bare steel) the scale's flakes and broad swells as well.
float relief(vec2 p, float rough) {
  vec2 q = TURN * p;
  float height = noise(TURN * q * 0.21 + 13.0) * 0.2;
  if (rough > 0.0) {
    height += (noise(p.yx * 0.027 + 3.0) * 0.45 + noise(q * 0.062 + 5.0) * 0.5) * rough;
  }
  return height;
}

void main() {
  vec2 view = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) * (1.0 / uScale);
  vec2 page = view + vec2(0.0, uScroll);
  float y = page.y;

  // Where one layer gives way to the next, the line between them wanders. Only the nearest
  // line matters to a pixel, and only near it.
  float upper = (uStrata.x + uStrata.y) * 0.5;
  float lower = (uStrata.y + uStrata.z) * 0.5;
  float edge = y < upper ? uStrata.x : (y < lower ? uStrata.y : uStrata.z);
  float row = y < upper ? 3.1 : (y < lower ? 14.6 : 27.3);
  float off = abs(y - edge);
  float wander = 0.0;
  if (off < 230.0) {
    wander = (noise(vec2(page.x * 0.0052, row)) - 0.5) * 170.0;
    wander += (noise(vec2(page.x * 0.0155, row + 7.0)) - 0.5) * 70.0;
    wander += (noise(vec2(page.x * 0.045, row + 3.0)) - 0.5) * 26.0;
    wander *= 1.0 - smoothstep(170.0, 230.0, off);
  }
  float toOxide = smoothstep(-34.0, 34.0, y - uStrata.x + wander);
  float toSteel = smoothstep(-34.0, 34.0, y - uStrata.y + wander);
  float toFar = smoothstep(-34.0, 34.0, y - uStrata.z + wander);
  float inPatina = 1.0 - toOxide + toFar;
  float inOxide = toOxide * (1.0 - toSteel);
  float inSteel = toSteel * (1.0 - toFar);

  float grain = noise(page * 0.8);
  float mottle = 0.5;
  float fine = 0.5;
  float tone = 0.5;
  if (inPatina + inOxide > 0.0) {
    float blotch = turned4(page * 0.0021);
    mottle = turned4(page * 0.0105 + 31.7);
    fine = turned3(TURN * page * 0.085 + 5.0);
    tone = blotch * 0.62 + mottle * 0.38;
  }

  // The stamp: the tagline's letters, their edges for the light, and a blurred copy of the
  // sheet, which is the metal the stamp worked.
  float letter = 0.0;
  float nearLetter = 0.0;
  vec2 bevel = vec2(0.0);
  vec2 stampAt = page / uStampSize;
  if (stampAt.x > 0.0 && stampAt.x < 1.0 && stampAt.y > 0.0 && stampAt.y < 1.0) {
    vec2 texel = 1.3 / uStampSize;
    letter = textureLod(uStamp, stampAt, uStampLod).r;
    bevel.x = textureLod(uStamp, stampAt + vec2(texel.x, 0.0), uStampLod).r - letter;
    bevel.y = textureLod(uStamp, stampAt + vec2(0.0, texel.y), uStampLod).r - letter;
    nearLetter = min(1.0, textureLod(uStamp, stampAt, uStampLod + 5.0).r * 1.7) * (1.0 - letter);
  }

  vec3 body = vec3(0.0);
  float rusted = 1.0;

  if (inPatina > 0.0) {
    vec3 rust = vec3(0.659, 0.298, 0.153);
    vec3 deepRust = vec3(0.459, 0.212, 0.125);
    vec3 bloom = vec3(0.83, 0.47, 0.2);
    vec3 soot = vec3(0.2, 0.09, 0.055);
    float runs = square3(vec2(page.x * 0.021, page.y * 0.0016) + 7.3);
    vec3 patina = mix(deepRust, rust, smoothstep(0.3, 0.62, tone));
    patina = mix(patina, bloom, smoothstep(0.52, 0.8, mottle * 0.55 + fine * 0.6) * 0.55);
    patina = mix(patina, soot, smoothstep(0.56, 0.78, runs) * 0.5);
    patina *= 0.84 + 0.32 * fine;
    patina *= 0.96 + 0.08 * grain;
    float pit = smoothstep(0.56, 0.84, noise(TURN * page * 0.12 + 50.0) * 0.55 + fine * 0.6);
    patina *= 1.0 - 0.42 * pit * (1.0 - nearLetter);
    // Worked metal rusts brightest, so the letters stand in a lighter ground than the plate's.
    patina = mix(patina, bloom * (1.08 + 0.16 * fine), nearLetter * 0.82);
    vec3 surface = patina;
    if (uWeather < 1.0 && toFar < 0.5) {
      float rolled = square3(vec2(page.x * 0.0013, page.y * 0.045) + 3.0);
      vec3 millScale = vec3(0.15, 0.172, 0.19) * (0.72 + 0.66 * rolled);
      millScale += vec3(0.012, 0.02, 0.03) * mottle;
      millScale *= 0.95 + 0.1 * grain;
      // Rust takes the worked metal at once, so the tagline reads from the first frame.
      float seed = turned4(page * 0.0058 + 11.0) * 0.78 + fine * 0.22;
      rusted = smoothstep(0.0, 0.16, uWeather * 1.42 - seed + nearLetter * 0.95);
      surface = mix(millScale, patina, rusted);
      surface += vec3(0.42, 0.17, 0.03) * rusted * (1.0 - rusted) * 4.0;
    }
    body += surface * inPatina;
  }

  if (inOxide > 0.0) {
    float laminar = square3(vec2(page.x * 0.0035, page.y * 0.028) + 21.0);
    vec3 oxide = mix(vec3(0.17, 0.07, 0.045), vec3(0.4, 0.17, 0.095), smoothstep(0.3, 0.72, tone * 0.55 + laminar * 0.5));
    oxide = mix(oxide, vec3(0.52, 0.25, 0.12), smoothstep(0.62, 0.86, mottle * 0.6 + fine * 0.5) * 0.4);
    oxide *= 0.84 + 0.3 * fine;
    oxide *= 0.96 + 0.08 * grain;
    body += oxide * inOxide;
  }

  if (inSteel > 0.0) {
    float rolled = square3(vec2(page.x * 0.0013, page.y * 0.045) + 3.0);
    float brushed = noise(vec2(page.x * 0.012, page.y * 0.42));
    vec3 steel = vec3(0.153, 0.157, 0.149) * (0.74 + 0.34 * rolled);
    steel *= 0.95 + 0.1 * brushed;
    steel *= 0.97 + 0.06 * grain;
    // Temper colors: the steel next to a rusting layer took its heat, straw nearest, then
    // purple, then blue, fading into the plate.
    float heat = max(exp(-max(0.0, y - uStrata.y + wander) / 380.0), exp(-max(0.0, uStrata.z - y - wander) / 380.0));
    vec3 temper = mix(vec3(0.15, 0.25, 0.44), vec3(0.37, 0.2, 0.4), smoothstep(0.22, 0.55, heat));
    temper = mix(temper, vec3(0.64, 0.45, 0.2), smoothstep(0.55, 0.92, heat));
    steel = mix(steel, temper * (0.62 + 0.5 * rolled) * (0.9 + 0.2 * brushed), smoothstep(0.04, 0.5, heat) * 0.36);
    body += steel * inSteel;
  }

  float line = max(max(toOxide * (1.0 - toOxide), toSteel * (1.0 - toSteel)), toFar * (1.0 - toFar)) * 4.0;
  body *= 1.0 - 0.62 * line;

  float metal = mix(0.5, 0.07, rusted) * inPatina + 0.05 * inOxide + 0.2 * inSteel;
  float rough = mix(0.3, 1.0, rusted) * inPatina + 0.85 * inOxide + 0.16 * inSteel;
  float coarse = 1.0 - inSteel;
  float height = relief(page, coarse);
  vec2 slope = vec2(relief(page + vec2(1.5, 0.0), coarse) - height, relief(page + vec2(0.0, 1.5), coarse) - height) * 6.4 * rough;
  vec3 normal = normalize(vec3(-slope + bevel * 5.2, 1.0));

  vec2 toLight = uPointer - view;
  vec3 light = normalize(vec3(toLight, 360.0));
  float reach = 1.0 / (1.0 + dot(toLight, toLight) / (640.0 * 640.0));
  float lit = clamp(dot(normal, light), 0.0, 1.0);
  float shine = pow(clamp(dot(reflect(-light, normal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), mix(22.0, 9.0, inSteel));
  vec3 shaded = body * (0.56 + 0.16 * inPatina + 0.2 * lit + 0.5 * lit * reach);
  shaded += vec3(1.0, 0.93, 0.84) * shine * metal * (0.25 + 0.75 * reach);

  // A struck plate: the blow's heat where it landed, and a ring of it running out through the
  // metal as it cools.
  if (uStruck.z >= 0.0) {
    float age = uStruck.z;
    float from = distance(page, uStruck.xy);
    float ring = (from - 120.0 - age * 560.0) / (70.0 + age * 130.0);
    float glow = exp(-ring * ring) * exp(-age * 1.15) * 1.05 + exp(-from * from / (330.0 * 330.0)) * exp(-age * 1.0) * 1.2;
    shaded += vec3(1.0, 0.48, 0.12) * glow * (0.75 + 0.5 * fine) + vec3(0.5, 0.42, 0.25) * glow * glow * 0.35;
  }

  float recess = letter * (1.0 - toOxide);
  shaded = mix(shaded, shaded * 0.1 + vec3(0.008, 0.006, 0.004), recess * 0.95);

  vec2 centered = view * uScale / uCanvas - 0.5;
  shaded *= 1.0 - 0.26 * dot(centered, centered);
  shaded += (hash(gl_FragCoord.xy) - 0.5) * 0.014;
  color = vec4(shaded, 1.0);
}`;

/**
 * What a world's two handlers share: how a strike reaches its plate, in page pixels. `forge`
 * sets it once the plate can take one, and `blow` calls it.
 * @returns {{ strike: ((x: number, y: number) => void) | null }}
 */
const kept = () => keep(() => ({ strike: null }));

/**
 * Starts compiling the plate's program and calls `ready` with it once the browser has, without
 * the page waiting on the compiler: asking for a program's status makes the browser finish it
 * first, so where it can say whether it is done, that is asked instead, a frame at a time.
 * @param {WebGL2RenderingContext} gl
 * @param {() => boolean} gone whether the context this was started for is no longer the one in use
 * @param {(program: WebGLProgram) => void} ready @param {() => void} failed
 */
function build(gl, gone, ready, failed) {
  const program = gl.createProgram();
  const shaders = [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ].map(([kind, source]) => {
    const shader = gl.createShader(Number(kind));
    if (shader) {
      gl.shaderSource(shader, String(source));
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    return shader;
  });
  gl.linkProgram(program);
  const background = gl.getExtension("KHR_parallel_shader_compile");
  const check = () => {
    if (gone() || gl.isContextLost()) return;
    if (background && !gl.getProgramParameter(program, background.COMPLETION_STATUS_KHR)) {
      requestAnimationFrame(check);
    } else if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
      ready(program);
    } else {
      const said = shaders.map((shader) => (shader ? gl.getShaderInfoLog(shader) : ""));
      console.warn("corten.run: the plate's program did not build", gl.getProgramInfoLog(program), ...said);
      failed();
    }
  };
  check();
}

/**
 * A sheet of random values the shader's noise is read from: the same sheet every time, so the
 * plate is the same plate on every visit.
 * @param {WebGL2RenderingContext} gl @param {number} unit the texture unit it is bound to
 */
function noiseSheet(gl, unit) {
  const side = 256;
  const values = new Uint8Array(side * side);
  let state = 0x0c047e11;
  for (let n = 0; n < values.length; n++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values[n] = state >>> 24;
  }
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, side, side, 0, gl.RED, gl.UNSIGNED_BYTE, values);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
}

/**
 * Draws the tagline's words where the page laid them out, white on black, as the sheet the
 * shader stamps into the plate.
 * @param {OffscreenCanvas} sheet @param {HTMLSpanElement[]} words
 * @param {number} width @param {number} height the part of the page the sheet covers, in CSS pixels
 * @param {number} ratio the sheet's pixels to a CSS pixel
 */
function stampWords(sheet, words, width, height, ratio) {
  sheet.width = Math.max(1, Math.round(width * ratio));
  sheet.height = Math.max(1, Math.round(height * ratio));
  const ink = sheet.getContext("2d");
  if (!ink) return;
  ink.setTransform(ratio, 0, 0, ratio, 0, 0);
  ink.fillStyle = "#000";
  ink.fillRect(0, 0, width, height);
  ink.fillStyle = "#fff";
  for (const word of words) {
    const box = word.getBoundingClientRect();
    const style = getComputedStyle(word);
    ink.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    if ("fontStretch" in ink) ink.fontStretch = "condensed";
    const written = word.textContent ?? "";
    const text = style.textTransform === "uppercase" ? written.toUpperCase() : written;
    const measured = ink.measureText(text);
    const tall = measured.fontBoundingBoxAscent + measured.fontBoundingBoxDescent;
    const left = box.left + window.scrollX;
    const baseline = box.top + window.scrollY + (box.height - tall) / 2 + measured.fontBoundingBoxAscent;
    ink.save();
    ink.translate(left, baseline);
    ink.scale(box.width / Math.max(1, measured.width), 1);
    ink.fillText(text, 0, 0);
    ink.restore();
  }
}

/**
 * Keeps the tagline inside its column. It is sized for a condensed DIN; where the reader's
 * device has a wider face in its place, the longest word would run off the column, so the line
 * is set smaller by as much as it runs over.
 * @param {HTMLHeadingElement} line @param {HTMLSpanElement[]} words
 */
function fit(line, words) {
  line.style.fontSize = "";
  const column = line.getBoundingClientRect();
  const reach = Math.max(...words.map((word) => word.getBoundingClientRect().right)) - column.left;
  if (reach > column.width + 0.5) {
    line.style.fontSize = `${(parseFloat(getComputedStyle(line).fontSize) * column.width) / reach}px`;
  }
}

/**
 * What a context needs to draw the plate: its program's uniforms, its textures and the sheet
 * the tagline is stamped on.
 * @param {WebGL2RenderingContext} gl @param {WebGLProgram} program
 */
function rig(gl, program) {
  gl.useProgram(program);
  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "aCorner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  noiseSheet(gl, 1);
  gl.uniform1i(gl.getUniformLocation(program, "uNoise"), 1);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uStamp"), 0);

  return {
    gl,
    sheet: new OffscreenCanvas(1, 1),
    // What the sheet was last drawn from, so it is drawn again only when that changes.
    stamped: "",
    at: {
      canvas: gl.getUniformLocation(program, "uCanvas"),
      scale: gl.getUniformLocation(program, "uScale"),
      scroll: gl.getUniformLocation(program, "uScroll"),
      pointer: gl.getUniformLocation(program, "uPointer"),
      weather: gl.getUniformLocation(program, "uWeather"),
      strata: gl.getUniformLocation(program, "uStrata"),
      struck: gl.getUniformLocation(program, "uStruck"),
      stampSize: gl.getUniformLocation(program, "uStampSize"),
      stampLod: gl.getUniformLocation(program, "uStampLod"),
    },
  };
}

/**
 * @param {HTMLElement} world the root: `data-forged` once the plate is drawn, `data-flat` when
 *   it will not be
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLHeadingElement} line the tagline
 * @param {HTMLSpanElement[]} words its words
 * @param {HTMLElement[]} strata the layers, top to bottom, and the far side after them
 * @param {HTMLAnchorElement[]} bands the gauge's link to each layer; the one being read is
 *   `aria-current`
 * @param {AbortSignal} signal
 */
export function forge(world, canvas, line, words, strata, bands, signal) {
  const shared = kept();
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const touch = window.matchMedia("(hover: none)").matches;
  const plate = {
    /** @type {ReturnType<typeof rig> | null} */
    gear: null,
    // Which context the gear is being built for: a lost one's late answers are dropped.
    turn: 0,
    // Set once the plate is given up for good, so a restored context does not bring it back.
    flat: false,
    scale: 1,
    // Lowered when frames come late: the plate is drawn softer before it is drawn slowly.
    cap: 1.5,
    late: { sum: 0, frames: 0 },
    // Where the layers start, in page pixels: surface, seam, steel, far side.
    tops: [0, 0, 0, 0],
    current: -2,
    // Where the light is and where it is heading, in window pixels.
    light: { x: window.innerWidth * 0.68, y: window.innerHeight * 0.3 },
    aim: { x: window.innerWidth * 0.68, y: window.innerHeight * 0.3 },
    began: 0,
    last: 0,
    weather: still ? 1 : 0,
    /** @type {{ x: number, y: number, at: number } | null} */
    struck: null,
    frame: 0,
    // Whether the page has moved under the plate since it was last measured.
    stale: true,
  };

  const ask = () => {
    if (!plate.frame && !signal.aborted) plate.frame = requestAnimationFrame(frame);
  };

  // Measures the page for the next frame, however many things asked in this one.
  const measure = () => {
    plate.stale = true;
    ask();
  };

  const flatten = () => {
    plate.gear = null;
    delete world.dataset.forged;
    world.dataset.flat = "";
  };

  /** Sizes the canvas and stamps the tagline where the page now has it. @param {ReturnType<typeof rig>} gear */
  const lay = (gear) => {
    const { gl, at } = gear;
    // The canvas's own box, which is the window less its scrollbar: the page's pixels and the
    // plate's are then the same ones, and the stamped words sit under the page's.
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    // At most about 2.2 million pixels a frame: rust forgives being drawn a little soft.
    plate.scale = Math.min(window.devicePixelRatio || 1, plate.cap, Math.sqrt(2_200_000 / (width * height)));
    const wide = Math.max(1, Math.round(width * plate.scale));
    const tall = Math.max(1, Math.round(height * plate.scale));
    if (canvas.width !== wide || canvas.height !== tall) {
      canvas.width = wide;
      canvas.height = tall;
    }
    gl.viewport(0, 0, wide, tall);
    const covered = Math.max(1, plate.tops[0] ?? height);
    const ratio = Math.min(2, window.devicePixelRatio || 1, 2048 / width);
    const boxes = words.flatMap((word) => {
      const box = word.getBoundingClientRect();
      return [box.left + window.scrollX, box.top + window.scrollY, box.width, box.height];
    });
    const stamped = [width, covered, ratio, ...boxes].map((n) => n.toFixed(1)).join();
    if (stamped !== gear.stamped) {
      gear.stamped = stamped;
      stampWords(gear.sheet, words, width, covered, ratio);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gear.sheet);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.uniform2f(at.stampSize, width, covered);
    gl.uniform1f(at.stampLod, Math.max(0, Math.log2(ratio / plate.scale)));
  };

  /** Draws the plate; true when it has more to draw. @param {ReturnType<typeof rig>} gear @param {number} now */
  const paint = (gear, now) => {
    const { gl, at } = gear;
    if (!plate.began) plate.began = now;
    const since = plate.last ? now - plate.last : 0;
    // Frames that follow one another say what the plate costs here. When they come late it is
    // drawn at fewer pixels, and given up where even that is slow.
    if (since > 0 && since < 200 && now - plate.began > 600) {
      plate.late.sum += since;
      plate.late.frames += 1;
      if (plate.late.frames === 30) {
        const each = plate.late.sum / 30;
        plate.late = { sum: 0, frames: 0 };
        if (each > 25 && plate.cap > 0.6) {
          plate.cap = Math.max(0.6, Math.min(plate.cap, plate.scale) * 0.75);
          plate.stale = true;
        } else if (each > 90) {
          plate.flat = true;
          flatten();
          gl.getExtension("WEBGL_lose_context")?.loseContext();
          return false;
        }
      }
    }
    plate.last = now;
    let moving = plate.stale;
    if (plate.weather < 1) {
      // Rust takes the plate at an even pace: around the letters first, the last bare steel
      // five and a half seconds in.
      plate.weather = Math.min(1, (now - plate.began) / 5600);
      moving = true;
    }
    if (touch && !still) {
      // No pointer to follow: the light crosses the plate as the page is read.
      plate.aim.x = window.innerWidth * (0.5 + 0.36 * Math.sin(window.scrollY / 520));
      plate.aim.y = window.innerHeight * 0.34;
    }
    const dx = plate.aim.x - plate.light.x;
    const dy = plate.aim.y - plate.light.y;
    if (Math.abs(dx) + Math.abs(dy) > 0.6) {
      // The same glide whatever the screen's rate.
      const step = since > 0 && since < 200 ? 1 - Math.exp(-since / 90) : 0.17;
      plate.light.x += dx * step;
      plate.light.y += dy * step;
      moving = true;
    }
    let age = -1;
    if (plate.struck) {
      age = Math.max(0, (now - plate.struck.at) / 1000);
      if (age > 4.5) {
        plate.struck = null;
        age = -1;
      }
      moving = true;
    }
    const [, seam = 0, steel = 0, far = 0] = plate.tops;
    gl.uniform2f(at.canvas, canvas.width, canvas.height);
    gl.uniform1f(at.scale, plate.scale);
    gl.uniform1f(at.scroll, window.scrollY);
    gl.uniform2f(at.pointer, plate.light.x, plate.light.y);
    gl.uniform1f(at.weather, plate.weather);
    gl.uniform3f(at.strata, seam, steel, far);
    gl.uniform3f(at.struck, plate.struck?.x ?? 0, plate.struck?.y ?? 0, age);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!("forged" in world.dataset)) {
      world.dataset.forged = "";
      delete world.dataset.flat;
    }
    return moving;
  };

  /** @param {number} now */
  function frame(now) {
    plate.frame = 0;
    if (signal.aborted) return;
    if (plate.stale) {
      plate.tops = strata.map((layer) => layer.getBoundingClientRect().top + window.scrollY);
      if (plate.gear) lay(plate.gear);
    }
    const middle = window.scrollY + window.innerHeight / 2;
    const [, seam = 0, steel = 0, far = Infinity] = plate.tops;
    const current = middle >= far ? -1 : middle >= steel ? 2 : middle >= seam ? 1 : 0;
    if (current !== plate.current) {
      plate.current = current;
      bands.forEach((band, n) => {
        if (n === current) band.setAttribute("aria-current", "location");
        else band.removeAttribute("aria-current");
      });
    }
    const moving = plate.gear ? paint(plate.gear, now) : false;
    plate.stale = false;
    if (moving) ask();
    else plate.last = 0;
  }

  // Asks for a context and builds the plate for it: at the start, and when a lost one is back.
  const equip = () => {
    if (plate.flat || typeof OffscreenCanvas === "undefined") return flatten();
    // A software renderer draws this plate at a frame or two a second: the flat page is better.
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      failIfMajorPerformanceCaveat: true,
    });
    if (!gl) return flatten();
    const turn = ++plate.turn;
    build(
      gl,
      () => signal.aborted || turn !== plate.turn,
      (program) => {
        plate.gear = rig(gl, program);
        measure();
      },
      flatten,
    );
  };

  fit(line, words);
  window.addEventListener("scroll", ask, { passive: true, signal });
  window.addEventListener(
    "resize",
    () => {
      fit(line, words);
      measure();
    },
    { signal },
  );
  if (!still) {
    /** @param {PointerEvent} event */
    const follow = (event) => {
      if (event.type === "pointermove" && event.pointerType === "touch") return;
      plate.aim.x = event.clientX;
      plate.aim.y = event.clientY;
      ask();
    };
    window.addEventListener("pointermove", follow, { passive: true, signal });
    window.addEventListener("pointerdown", follow, { passive: true, signal });
    shared.strike = (x, y) => {
      if (!plate.gear) return;
      plate.struck = { x, y, at: performance.now() };
      ask();
    };
  }
  canvas.addEventListener(
    "webglcontextlost",
    (event) => {
      // The stylesheet's flat layers take over until the context is back.
      event.preventDefault();
      plate.turn += 1;
      flatten();
    },
    { signal },
  );
  canvas.addEventListener(
    "webglcontextrestored",
    () => {
      // The plate comes back as it was left: weathered.
      plate.weather = 1;
      equip();
    },
    { signal },
  );
  // The layers move when the page's height does (an answer swapped in, a font arriving).
  const watcher = new ResizeObserver(measure);
  watcher.observe(world);
  signal.addEventListener("abort", () => {
    watcher.disconnect();
    cancelAnimationFrame(plate.frame);
    shared.strike = null;
    plate.gear?.gl.getExtension("WEBGL_lose_context")?.loseContext();
    plate.gear = null;
  });
  measure();
  // A browser's first WebGL context can take it a while to make, so the page is painted and
  // answering before the plate is asked for: the second frame from here is after the first.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!signal.aborted) equip();
    }),
  );
}

/**
 * A plate was struck (seam.rs's `PlateStruck`, sent by the patch that drew it): the plate
 * behind the page takes the blow where the struck name is.
 * @param {PlateStruck} event
 */
export function blow(event) {
  if (!(event.target instanceof Element)) return;
  const box = event.target.getBoundingClientRect();
  kept().strike?.(box.left + box.width / 2 + window.scrollX, box.top + box.height / 2 + window.scrollY);
}
