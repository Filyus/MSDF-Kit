# MSDF-Kit

WASM library for generating **SDF / MSDF / MTSDF** atlases from fonts and SVG icons.
Built on [msdfgen](https://github.com/Chlumsky/msdfgen) v1.13, compiled to WebAssembly via Emscripten.

High-quality, resolution-independent text and icon rendering for WebGL / WebGPU.

## Architecture

**TypeScript API** — `MsdfKit` class: loadFont, generateGlyph, generateIcon, generateGlyphs, getFontMetrics, getKerning. `Atlas Packer`: MaxRects bin-packing with multi-page and power-of-two support.

**WASM Module** (C++ / Emscripten) — `wrapper.cpp`: Emscripten exports bridging JS to msdfgen. `svg_shape.cpp`: SVG path `d` attribute parser (no XML / tinyxml2).

**Native Libraries** — `msdfgen-core`: SDF/MSDF/MTSDF generation, edge coloring, shape primitives. `FreeType` (Emscripten port): TTF/OTF font parsing. `HarfBuzz` (Emscripten port, optional): OpenType text shaping — ligatures, kerning, complex scripts, RTL.

### Data Flow

**Text:** TTF/OTF → HarfBuzz shaping → glyph IDs + EM-normalised positions → msdfgen Shape → edge coloring → SDF generation → float bitmap (1–4 ch) → MaxRects packing → packed atlas (default: RGBA uint8)

**Icon:** SVG path `d` → msdfgen Shape → SDF generation → float bitmap → atlas

### SDF Modes

| Mode | Channels | Use Case |
|------|----------|----------|
| **SDF** | 1 (grayscale) | Simple distance field, smooth edges |
| **PSDF** | 1 (grayscale) | Pseudo-SDF, faster but less accurate |
| **MSDF** | 3 (RGB) | Multi-channel, preserves sharp corners |
| **MTSDF** | 4 (RGBA) | MSDF + true SDF in alpha for effects (shadows, outlines) |

## Project Structure

```
MSDF-Kit/
├── src/                     C++ sources → WASM
│   ├── wrapper.cpp          Emscripten exports (bridge to msdfgen)
│   └── svg_shape.cpp/h      SVG path 'd' parser
├── typescript/              TypeScript API
│   ├── index.ts             MsdfKit class (public API)
│   ├── types.ts             Interfaces & type definitions
│   ├── wasm-loader.ts       WASM module loader
│   └── atlas-packer.ts      MaxRects bin-packing
├── shader/msdf.glsl         Reference MTSDF fragment shader
├── extern/msdfgen/          msdfgen v1.13 (git submodule)
├── build/                   WASM output (msdf-kit.wasm + msdf-kit.js)
├── dist/                    TypeScript output
├── test/                    Vitest test suite
├── CMakeLists.txt           Emscripten / CMake config
├── build.ps1                Build script (PowerShell)
└── package.json
```

## Prerequisites

- **Emscripten SDK** — available via `EMSDK`, `PATH`, or a standard local install; you can also pass `-EmsdkRoot` to `.\build.ps1`
- **Visual Studio 2022** — for CMake and Ninja (bundled with VS)
- **Node.js** 18+
- **Git** — for submodule initialization

## Build

Recommended build entrypoints:

- `npm run build` — primary build command
- `.\build.ps1` — direct PowerShell entrypoint with optional overrides such as `-EmsdkRoot` and `-VsCMakeBase`

```powershell
npm run build            # recommended
.\build.ps1              # full build: WASM + TypeScript
.\build.ps1 -Clean       # clean rebuild
.\build.ps1 -SkipWasm    # TypeScript only
.\build.ps1 -SkipTs      # WASM only
.\\build.ps1 -EmsdkRoot D:\emsdk
```

The script locates Emscripten, CMake, and Ninja automatically, then:

1. `emcmake cmake` — configure with Emscripten toolchain
2. `cmake --build` — compile C++ → `build/msdf-kit.wasm` + `build/msdf-kit.js`
3. `tsc` — compile TypeScript → `dist/`

<details>
<summary>Manual build</summary>

```powershell
git submodule update --init --recursive
npm install
emcmake cmake -B cmake-build -S . -DCMAKE_BUILD_TYPE=Release
cmake --build cmake-build
npx tsc
```

</details>

<details>
<summary>CMake details</summary>

- **`MSDFGEN_CORE_ONLY=ON`** — only the core SDF generation library
- **Ext sources compiled directly** — `import-font.cpp`, `import-svg.cpp`, `resolve-shape-geometry.cpp` are part of MSDF-Kit (not through msdfgen-ext)
- **No tinyxml2** — `MSDFGEN_USE_TINYXML2` is omitted; we parse SVG path `d` attributes directly
- **FreeType via Emscripten port** — `-sUSE_FREETYPE=1`
- **`MSDF_KIT_HARFBUZZ=ON`** (default) — enables HarfBuzz via `-sUSE_HARFBUZZ=1`; disable with `-DMSDF_KIT_HARFBUZZ=OFF` to reduce binary size (see table below)

</details>

## Binary Size

Measured with `-O3`, Emscripten. Servers and CDNs typically serve WASM gzip-compressed.

| Config | Raw | Gzip |
|--------|-----|------|
| With HarfBuzz (`MSDF_KIT_HARFBUZZ=ON`) | 1,273 KB | 488 KB |
| Without HarfBuzz (`MSDF_KIT_HARFBUZZ=OFF`) | 712 KB | 306 KB |
| HarfBuzz overhead | 561 KB | 182 KB |

## Testing

```powershell
npm test                              # all tests
npx vitest run --reporter=verbose     # verbose output
npx vitest run test/test-packer.ts    # single file
```

| File | Type | Description |
|------|------|-------------|
| `test-packer.ts` | Unit | MaxRects bin-packing, multi-page, float→uint8 |
| `test-wasm.ts` | Integration | WASM module loading, low-level C API |
| `test-font.ts` | Integration | Font loading → glyph MTSDF pipeline |
| `test-icon.ts` | Integration | SVG path → MTSDF, edge coloring modes |

> Integration tests require `.\build.ps1` first. Font tests need a TTF in `test/fixtures/`.

## API

`MsdfKit.create()` resolves the packaged `msdf-kit.wasm` and `msdf-kit.js` automatically — recommended for Vite and other bundlers. To host the WASM files yourself pass a custom URL:

```typescript
const msdf = await MsdfKit.create('/assets/msdf-kit.wasm');
```

### Approach 1 — Charset atlas (known glyph set, no shaping)

Suitable for static UI text, numbers, icons, or any case where you know the characters upfront and don't need ligatures or complex script support.

```typescript
import { MsdfKit } from 'msdf-kit';

const msdf = await MsdfKit.create();
const font = msdf.loadFont(await fetch('Roboto-Regular.ttf').then(r => r.arrayBuffer()));

// Pre-generate a fixed glyph set
const glyphs = msdf.generateGlyphs(font, 'ABCabc0123 !', { width: 32, height: 32, pxRange: 4 });

// SVG icons can be packed into the same atlas
const icon = msdf.generateIcon('arrow', 'M10 20 L30 50 L10 80 Z', [100, 100], { width: 48, height: 48, pxRange: 4 });

const atlas = msdf.packAtlas([...glyphs, icon], {
  maxWidth: 2048,
  maxHeight: 2048,
  padding: 1,
  pot: true,
  atlasFormat: 'rgba8', // default
});
// atlas.textures  — (Uint8Array | Float32Array)[] (one packed page per item)
// atlas.regions   — Map<string, AtlasRegion>  keys = your IDs: 'A', 'B', 'arrow', ...
// atlas.width/height — page dimensions

// Metrics for manual layout
const metrics = msdf.getFontMetrics(font);
const kern = msdf.getKerning(font, 65, 86); // A–V pair

msdf.destroyFont(font);
msdf.dispose();
```

### Approach 2 — Shaped text (HarfBuzz)

Suitable for dynamic text, multilingual content, ligatures, RTL, or any OpenType feature. HarfBuzz returns the correct glyph IDs and positions — no manual kerning needed.

```typescript
import { MsdfKit } from 'msdf-kit';

const msdf = await MsdfKit.create();
const font = msdf.loadFont(await fetch('Roboto-Regular.ttf').then(r => r.arrayBuffer()));

const glyphConfig = { width: 32, height: 32, pxRange: 4 };

// Shape text — HarfBuzz resolves ligatures, kerning, substitutions
// Each glyph has: glyphId, xOffset, yOffset, xAdvance, yAdvance, cluster
const shaped = msdf.layoutText(font, 'Hello, мир!');

// Render only unique glyph IDs
const seen = new Map<number, AtlasEntry>();
for (const g of shaped)
  if (!seen.has(g.glyphId))
    seen.set(g.glyphId, msdf.generateGlyphById(`g${g.glyphId}`, font, g.glyphId, glyphConfig));

const atlas = msdf.packAtlas([...seen.values()]);

// Draw: iterate shaped glyphs, advance pen by xAdvance
let penX = 0;
for (const g of shaped) {
  const region = atlas.regions.get(`g${g.glyphId}`);
  // render region at (penX + g.xOffset, baseline + g.yOffset)
  penX += g.xAdvance;
}

msdf.destroyFont(font);
msdf.dispose();
```

### MsdfConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `width` | `number` | *required* | Bitmap width in pixels |
| `height` | `number` | *required* | Bitmap height in pixels |
| `pxRange` | `number` | *required* | Distance range in pixels (recommended: 4) |
| `mode` | `SdfMode` | `'mtsdf'` | `'sdf'` · `'psdf'` · `'msdf'` · `'mtsdf'` |
| `angleThreshold` | `number` | `3.0` | Edge coloring angle threshold (radians) |
| `coloring` | `string` | `'simple'` | `'simple'` · `'inkTrap'` · `'byDistance'` |

### PackOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `maxWidth` | `number` | `2048` | Maximum atlas page width |
| `maxHeight` | `number` | `2048` | Maximum atlas page height |
| `padding` | `number` | `1` | Pixels between entries |
| `pot` | `boolean` | `true` | Constrain to power-of-two dimensions |
| `pxRange` | `number` | `4` | Stored in result for shader use |
| `atlasFormat` | `'r8' \| 'r16f' \| 'r32f' \| 'rgba8' \| 'rgba16f' \| 'rgba32f'` | `'rgba8'` | Output atlas storage format |

### Text Shaping

`layoutText` runs full HarfBuzz shaping (ligatures, kerning, complex scripts, RTL) and returns
EM-normalised glyph positions. Each `ShapedGlyph` includes a `cluster` field — the byte offset
of the source character in the input string. Use `cluster` (not array index) to map shaped glyphs
back to source characters; ligatures and RTL may produce a different glyph count than input characters.
Use the resulting glyph IDs with `generateGlyphById` to render each glyph into an atlas:

**Coordinate system** — all values follow the OpenType convention:
- **Y-axis points up.** `ascender > 0`, `descender < 0`, baseline at Y = 0.
- **`xOffset` / `yOffset`** — displacement from the current pen position to the glyph origin.
- **`xAdvance`** — move the pen right by this amount after drawing the glyph (`yAdvance` for vertical scripts).
- **EM-normalised** — divide all raw font units by `unitsPerEm`. To get pixels: `value × fontSize`.

```typescript
import { MsdfKit } from 'msdf-kit';

const msdf = await MsdfKit.create();
const font = msdf.loadFont(await fetch('Roboto.ttf').then(r => r.arrayBuffer()));

// Shape text — returns glyphId + EM-normalised positions + cluster (source char byte offset) per glyph
const shaped = msdf.layoutText(font, 'Hello, мир!');

// Render unique glyphs into atlas entries
const glyphConfig = { width: 32, height: 32, pxRange: 4 };
const seen = new Map<number, AtlasEntry>();
for (const g of shaped) {
  if (!seen.has(g.glyphId))
    seen.set(g.glyphId, msdf.generateGlyphById(`g${g.glyphId}`, font, g.glyphId, glyphConfig));
}

const atlas = msdf.packAtlas([...seen.values()]);

// Lay out the string using HarfBuzz positions + atlas regions
let penX = 0;
for (const g of shaped) {
  const region = atlas.regions.get(`g${g.glyphId}`);
  // draw region at (penX + g.xOffset, baseline + g.yOffset)
  penX += g.xAdvance;
}
```

### WASM Exports

Low-level C functions (accessible via `module._functionName`):

All metric and position values are **EM-normalised** (1.0 = 1 em). To convert to pixels: `value × fontSize`.

| Function | Description |
|----------|-------------|
| `init()` | Initialize FreeType library |
| `loadFont(dataPtr, length)` | Load TTF/OTF → font handle |
| `shapeFromGlyph(font, codepoint)` | Glyph by Unicode codepoint → shape handle |
| `shapeFromGlyphId(font, glyphId)` | Glyph by OpenType glyph ID → shape handle |
| `layoutText(font, text, outCountPtr)` | Shape text with HarfBuzz → `float*` `[glyphId, xOff, yOff, xAdv, yAdv, cluster]` × N (EM-normalised; cluster = source char byte offset) |
| `shapeFromSvgPath(pathData, vbW, vbH)` | SVG path `d` → shape handle |
| `generateMtsdf(shape, w, h, pxRange, angle, coloring, sdfMode)` | Shape → float bitmap |
| `getGlyphMetrics(font, cp, ...)` | Glyph advance and bounds (EM-normalised) |
| `getFontMetrics(font, ...)` | Ascender, descender, lineHeight, unitsPerEm (EM-normalised) |
| `getKerning(font, cp1, cp2)` | Kerning between two codepoints (EM-normalised) |
| `getBitmapSize(wPtr, hPtr)` | Dimensions of last generated bitmap (px) |
| `destroyShape(handle)` | Free a shape |
| `destroyFont(handle)` | Free a font + HarfBuzz font |
| `destroyBitmap(ptr)` | Free a bitmap |

> `layoutText` and `shapeFromGlyphId` require a build with `MSDF_KIT_HARFBUZZ=ON` (default).

## GLSL Shader

Reference MTSDF fragment shader (`shader/msdf.glsl`):

```glsl
float median(float r, float g, float b) {
    return max(min(r, g), min(max(r, g), b));
}

float msdfAlpha(vec2 uv, vec2 texSize) {
    vec4 mtsdf = texture2D(u_msdfAtlas, uv);
    float sd = (median(mtsdf.r, mtsdf.g, mtsdf.b) - 0.5) * u_pxRange;
    float screenPxDist = sd / fwidth(sd);
    return clamp(screenPxDist + 0.5, 0.0, 1.0);
}
```

`median(r,g,b)` recovers the distance field from multi-channel encoding. `fwidth()` provides screen-space antialiasing for crisp edges at any zoom level. The alpha channel (true SDF) is available for effects like shadows and outlines.

## Texture Format Notes

`MSDF-Kit` generates glyphs and icons as float bitmaps first. `packAtlas()` can then return packed single-channel pages (`atlasFormat: 'r8'`, `'r16f'`, or `'r32f'`) for `sdf`/`psdf`, or packed RGBA pages (`atlasFormat: 'rgba8'`, `'rgba16f'`, or `'rgba32f'`) for `msdf`/`mtsdf` and mixed-channel workflows.

The default `rgba8` mode matches the standard MSDF workflow and is appropriate for normal text/icon rendering where the shader only needs the local distance band around the contour.

If you choose a single-channel atlas format (`r8`, `r16f`, or `r32f`), every packed entry must also be single-channel. That is intended for `sdf` and `psdf`. Multi-channel `msdf` and `mtsdf` entries must use an RGBA atlas format.

You do not inherently need `RGBA16F` just because the underlying signed distance is mathematically unbounded. In the usual MSDF pipeline, the useful range is the configured `pxRange` neighborhood around the edge, and values outside that range are expected to saturate.

### Standard MSDF Rendering

Typical text/icon rendering only uses the RGB median near the contour to compute coverage:

```glsl
vec3 msdf = texture(u_msdfAtlas, uv).rgb;
float sd = (median(msdf.r, msdf.g, msdf.b) - 0.5) * pxRange;
float opacity = clamp(sd / fwidth(sd) + 0.5, 0.0, 1.0);
```

or equivalently, with a precomputed screen-space scale factor:

```glsl
vec3 msdf = texture(u_msdfAtlas, uv).rgb;
float encoded = median(msdf.r, msdf.g, msdf.b);
float screenPxDistance = screenPxRange() * (encoded - 0.5);
float opacity = clamp(screenPxDistance + 0.5, 0.0, 1.0);
```

Even when the texture is `MTSDF`, standard sharp rendering typically uses only the RGB median because that preserves corners better than the true SDF in alpha. The alpha channel is available, but is usually reserved for effects or for blending away from MSDF artifacts.

In this mode, only the local band around `0.5` matters. Packed `RGBA8` is the normal storage format.

### Distance-Driven Rendering

Some renderers use the stored field itself as a signed-distance source for broader effects. A common MTSDF decode is:

```glsl
vec4 mtsdf = texture(u_msdfAtlas, uv);
float msdfDist = (0.5 - median(mtsdf.r, mtsdf.g, mtsdf.b)) * pxRange;
float sdfDist  = (0.5 - mtsdf.a) * pxRange;
float blend = smoothstep(pxRange * 0.1875, pxRange * 0.375, abs(msdfDist));
float dist = mix(msdfDist, sdfDist, blend);
```

That decoded `dist` can then drive effects directly:

```glsl
float stroke = 1.0 - smoothstep(strokeWidth - aa, strokeWidth + aa, abs(dist));
float iso = 1.0 - smoothstep(isoWidth - aa, isoWidth + aa, abs(fract(dist * isoFrequency) - 0.5));
float fill = 1.0 - smoothstep(-aa, aa, dist);
```

In this mode the renderer cares about the magnitude of the stored distance, not just whether it crosses the edge near `0.5`. If you need those larger distances preserved instead of saturated, use a float or half-float atlas.

`packAtlas()` returns packed `Uint8Array` RGBA pages by default. That output is ideal for standard MSDF coverage rendering, but it may not preserve enough distance range for shaders that reuse `dist` as a wider signed-distance input. In that case, use `packAtlas(entries, { atlasFormat: 'rgba16f' })` or `packAtlas(entries, { atlasFormat: 'rgba32f' })` to keep float atlas data on the CPU side before upload.

On the JavaScript side, byte atlas modes (`r8`, `rgba8`) return `Uint8Array` pages, while float atlas modes (`r16f`, `r32f`, `rgba16f`, `rgba32f`) return `Float32Array` pages. The `atlasFormat` field tells the renderer which GPU storage format you intend to use at upload time.

Use a float or half-float atlas only if your renderer intentionally uses the stored field as a wider signed-distance source for effects beyond the normal MSDF edge band, such as broad outlines, glows, shadows, morphology, or other distance-driven operations that rely on preserving distances outside the encoded `pxRange`.

## License

msdfgen is licensed under the MIT License. See `extern/msdfgen/LICENSE.txt`.
