# MSDF-Kit

WASM library for generating **SDF / MSDF / MTSDF** atlases from fonts and SVG icons.
Built on [msdfgen](https://github.com/Chlumsky/msdfgen) v1.13, compiled to WebAssembly via Emscripten.

High-quality, resolution-independent text and icon rendering for WebGL / WebGPU.

## Architecture

**TypeScript API** — `MsdfKit` class: loadFont, generateGlyph, generateIcon, generateGlyphs, getFontMetrics, getKerning. `Atlas Packer`: MaxRects bin-packing with multi-page and power-of-two support.

**WASM Module** (C++ / Emscripten) — `wrapper.cpp`: Emscripten exports bridging JS to msdfgen. `svg_shape.cpp`: SVG path `d` attribute parser (no XML / tinyxml2).

**Native Libraries** — `msdfgen-core`: SDF/MSDF/MTSDF generation, edge coloring, shape primitives. `FreeType` (Emscripten port): TTF/OTF font parsing.

### Data Flow

TTF/OTF or SVG path → msdfgen Shape → edge coloring → SDF generation → float bitmap (1–4 ch) → MaxRects packing → RGBA uint8 atlas

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

</details>

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

### Quick Start

```typescript
import { MsdfKit } from 'msdf-kit';

const msdf = await MsdfKit.create();

// Load font
const fontData = await fetch('Roboto-Regular.ttf').then(r => r.arrayBuffer());
const font = msdf.loadFont(fontData);

// Generate glyphs
const glyphs = msdf.generateGlyphs(font, 'ABCabc0123', {
  width: 32, height: 32, pxRange: 4,
});

// Generate icon from SVG path
const icon = msdf.generateIcon('M10 20 L30 50 L10 80 Z', [100, 100], {
  width: 48, height: 48, pxRange: 4,
});

// Pack into atlas
const atlas = msdf.packAtlas([...glyphs, icon], {
  maxWidth: 2048, maxHeight: 2048,
  padding: 1, pot: true,
});
// atlas.textures  — Uint8Array[] (RGBA, one per page)
// atlas.regions   — Map<string, AtlasRegion>
// atlas.width/height — page dimensions

// Kerning & metrics
const kern = msdf.getKerning(font, 65, 86); // A–V
const metrics = msdf.getFontMetrics(font);

// Cleanup
msdf.destroyFont(font);
msdf.dispose();
```

`MsdfKit.create()` resolves the packaged `msdf-kit.wasm` and `msdf-kit.js` automatically. This is the recommended setup for Vite and other bundlers, because you do not need to import files from `/public`.

If you want to host the WASM files yourself, you can still pass a custom URL:

```typescript
import { MsdfKit } from 'msdf-kit';

const msdf = await MsdfKit.create('/assets/msdf-kit.wasm');
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

### WASM Exports

Low-level C functions (accessible via `module._functionName`):

| Function | Description |
|----------|-------------|
| `init()` | Initialize FreeType library |
| `loadFont(dataPtr, length)` | Load TTF/OTF → font handle |
| `shapeFromGlyph(font, codepoint)` | Glyph → shape handle |
| `shapeFromSvgPath(pathData, vbW, vbH)` | SVG path `d` → shape handle |
| `generateMtsdf(shape, w, h, pxRange, angle, coloring, sdfMode)` | Shape → float bitmap |
| `getGlyphMetrics(font, cp, ...)` | Glyph advance and bounds |
| `getFontMetrics(font, ...)` | Ascender, descender, lineHeight, unitsPerEm |
| `getKerning(font, cp1, cp2)` | Kerning between two glyphs |
| `getBitmapSize(wPtr, hPtr)` | Dimensions of last generated bitmap |
| `destroyShape(handle)` | Free a shape |
| `destroyFont(handle)` | Free a font |
| `destroyBitmap(ptr)` | Free a bitmap |

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

## License

msdfgen is licensed under the MIT License. See `extern/msdfgen/LICENSE.txt`.
