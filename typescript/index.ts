import { getBundledGlueUrl, getBundledWasmUrl, loadWasmModule } from './wasm-loader.js';
import { packAtlas } from './atlas-packer.js';
import type {
  MsdfKitWasmModule,
  MsdfConfig,
  GlyphMetrics,
  FontMetrics,
  ShapedGlyph,
  AtlasEntry,
  PackedAtlas,
  PackOptions,
  FontHandle,
} from './types.js';

const COLORING_MAP = { simple: 0, inkTrap: 1, byDistance: 2 } as const;
const MODE_MAP = { sdf: 0, psdf: 1, msdf: 2, mtsdf: 3 } as const;
const CHANNELS_MAP = { sdf: 1, psdf: 1, msdf: 3, mtsdf: 4 } as const;

export class MsdfKit {
  private module: MsdfKitWasmModule;
  private fontDataPtrs = new Map<FontHandle, number>();

  private constructor(module: MsdfKitWasmModule) {
    this.module = module;
  }

  /** Create and initialize a MsdfKit instance. */
  static async create(wasmUrl: string = getBundledWasmUrl()): Promise<MsdfKit> {
    const glueUrl = wasmUrl === getBundledWasmUrl()
      ? getBundledGlueUrl()
      : undefined;
    const module = await loadWasmModule(wasmUrl, glueUrl);
    return new MsdfKit(module);
  }

  // === Font loading ===

  /** Load a font from an ArrayBuffer. Returns a font handle. */
  loadFont(data: ArrayBuffer): FontHandle {
    const m = this.module;
    const bytes = new Uint8Array(data);
    const ptr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, ptr);
    const handle = m._loadFont(ptr, bytes.length);
    if (handle < 0) {
      m._free(ptr);
      throw new Error('Failed to load font');
    }
    // FreeType keeps a reference to the data buffer, so we must keep it alive
    this.fontDataPtrs.set(handle, ptr);
    return handle;
  }

  /** Get global metrics of a loaded font. */
  getFontMetrics(font: FontHandle): FontMetrics {
    const m = this.module;
    const buf = m._malloc(8 * 4); // 4 doubles
    m._getFontMetrics(font, buf, buf + 8, buf + 16, buf + 24);
    const result: FontMetrics = {
      ascender: m.HEAPF64[buf >> 3],
      descender: m.HEAPF64[(buf + 8) >> 3],
      lineHeight: m.HEAPF64[(buf + 16) >> 3],
      unitsPerEm: m.HEAPF64[(buf + 24) >> 3],
    };
    m._free(buf);
    return result;
  }

  // === Single entry generation ===

  /** Generate an SDF bitmap for a single glyph by Unicode codepoint. */
  generateGlyph(id: string, font: FontHandle, codepoint: number, config: MsdfConfig): AtlasEntry {
    const m = this.module;
    const shapeHandle = m._shapeFromGlyph(font, codepoint);
    if (shapeHandle < 0) throw new Error(`Failed to create shape for codepoint ${codepoint}`);

    const metrics = this.getGlyphMetrics(font, codepoint);
    const mode = config.mode ?? 'mtsdf';
    let bitmap: Float32Array;
    try {
      bitmap = this.renderShape(shapeHandle, config);
    } finally {
      m._destroyShape(shapeHandle);
    }

    return {
      id,
      bitmap,
      width: config.width,
      height: config.height,
      channels: CHANNELS_MAP[mode],
      metrics,
    };
  }

  /** Generate an SDF bitmap from SVG path data. */
  generateIcon(id: string, svgPathData: string, viewBox: [number, number], config: MsdfConfig): AtlasEntry {
    const m = this.module;

    // Allocate string in WASM memory
    const strLen = svgPathData.length * 4 + 1;
    const strPtr = m._malloc(strLen);
    m.stringToUTF8(svgPathData, strPtr, strLen);

    const shapeHandle = m._shapeFromSvgPath(strPtr, viewBox[0], viewBox[1]);
    m._free(strPtr);

    if (shapeHandle < 0) throw new Error('Failed to create shape from SVG path');

    const mode = config.mode ?? 'mtsdf';
    let bitmap: Float32Array;
    try {
      bitmap = this.renderShape(shapeHandle, config);
    } finally {
      m._destroyShape(shapeHandle);
    }

    return {
      id,
      bitmap,
      width: config.width,
      height: config.height,
      channels: CHANNELS_MAP[mode],
    };
  }

  /** Shape a text string with HarfBuzz. Returns one entry per output glyph with
   *  EM-normalised positions. Use the glyph IDs with generateGlyphById. */
  layoutText(font: FontHandle, text: string): ShapedGlyph[] {
    const m = this.module;
    const strLen = text.length * 4 + 1;
    const strPtr = m._malloc(strLen);
    m.stringToUTF8(text, strPtr, strLen);

    const countPtr = m._malloc(4);
    const ptr = m._layoutText(font, strPtr, countPtr);
    m._free(strPtr);

    if (!ptr) {
      m._free(countPtr);
      return [];
    }

    const count = m.getValue(countPtr, 'i32');
    m._free(countPtr);

    const result: ShapedGlyph[] = [];
    for (let i = 0; i < count; i++) {
      const base = (ptr >> 2) + i * 5;
      result.push({
        glyphId:  m.HEAPF32[base],
        xOffset:  m.HEAPF32[base + 1],
        yOffset:  m.HEAPF32[base + 2],
        xAdvance: m.HEAPF32[base + 3],
        yAdvance: m.HEAPF32[base + 4],
      });
    }

    m._free(ptr);
    return result;
  }

  /** Generate an SDF bitmap for a glyph by its OpenType glyph ID.
   *  Use with glyph IDs returned by layoutText. */
  generateGlyphById(id: string, font: FontHandle, glyphId: number, config: MsdfConfig): AtlasEntry {
    const m = this.module;
    const shapeHandle = m._shapeFromGlyphId(font, glyphId);
    if (shapeHandle < 0) throw new Error(`Failed to create shape for glyph ID ${glyphId}`);

    const mode = config.mode ?? 'mtsdf';
    let bitmap: Float32Array;
    try {
      bitmap = this.renderShape(shapeHandle, config);
    } finally {
      m._destroyShape(shapeHandle);
    }

    return {
      id,
      bitmap,
      width: config.width,
      height: config.height,
      channels: CHANNELS_MAP[mode],
    };
  }

  // === Batch generation ===

  /** Generate MTSDF bitmaps for all characters in a charset string. */
  generateGlyphs(font: FontHandle, charset: string, config: MsdfConfig): AtlasEntry[] {
    const entries: AtlasEntry[] = [];
    const seen = new Set<number>();

    for (const char of charset) {
      const cp = char.codePointAt(0)!;
      if (seen.has(cp)) continue;
      seen.add(cp);

      try {
        entries.push(this.generateGlyph(String.fromCodePoint(cp), font, cp, config));
      } catch {
        // Skip glyphs that fail (e.g. missing in font)
      }
    }
    return entries;
  }

  // === Atlas packing ===

  /** Pack entries into a texture atlas. */
  packAtlas(entries: AtlasEntry[], options?: PackOptions): PackedAtlas {
    return packAtlas(entries, options);
  }

  // === Kerning ===

  /** Get kerning between two codepoints. */
  getKerning(font: FontHandle, cp1: number, cp2: number): number {
    return this.module._getKerning(font, cp1, cp2);
  }

  // === Cleanup ===

  /** Destroy a loaded font and free its resources. */
  destroyFont(font: FontHandle): void {
    this.module._destroyFont(font);
    const dataPtr = this.fontDataPtrs.get(font);
    if (dataPtr) {
      this.module._free(dataPtr);
      this.fontDataPtrs.delete(font);
    }
  }

  /** Dispose of the entire module. */
  dispose(): void {
    // Emscripten doesn't have a standard teardown, but we can null the ref
    (this.module as MsdfKitWasmModule | null) = null!;
  }

  // === Private helpers ===

  private getGlyphMetrics(font: FontHandle, codepoint: number): GlyphMetrics {
    const m = this.module;
    const buf = m._malloc(8 * 5); // 5 doubles
    m._getGlyphMetrics(font, codepoint, buf, buf + 8, buf + 16, buf + 24, buf + 32);
    const result: GlyphMetrics = {
      codepoint,
      advance: m.HEAPF64[buf >> 3],
      left: m.HEAPF64[(buf + 8) >> 3],
      bottom: m.HEAPF64[(buf + 16) >> 3],
      right: m.HEAPF64[(buf + 24) >> 3],
      top: m.HEAPF64[(buf + 32) >> 3],
    };
    m._free(buf);
    return result;
  }

  private renderShape(shapeHandle: number, config: MsdfConfig): Float32Array {
    const m = this.module;
    const angleThreshold = config.angleThreshold ?? 3.0;
    const coloringMode = COLORING_MAP[config.coloring ?? 'simple'];
    const mode = config.mode ?? 'mtsdf';
    const sdfMode = MODE_MAP[mode];
    const channels = CHANNELS_MAP[mode];

    const ptr = m._generateMtsdf(
      shapeHandle,
      config.width, config.height,
      config.pxRange,
      angleThreshold,
      coloringMode,
      sdfMode
    );

    if (!ptr) {
      const bounds = this.getShapeBounds(shapeHandle);
      const shapeW = bounds.right - bounds.left;
      const shapeH = bounds.top - bounds.bottom;
      const usableW = config.width - 2 * config.pxRange;
      const usableH = config.height - 2 * config.pxRange;

      let reason = 'unknown reason';
      if (usableW <= 0 || usableH <= 0) {
        reason = `bitmap ${config.width}x${config.height} is too small for pxRange=${config.pxRange}`;
      } else if (shapeW <= 0 || shapeH <= 0) {
        reason = `shape bounds are degenerate (${shapeW}x${shapeH}); the SVG path may be empty, open-only, or otherwise non-fillable`;
      } else {
        reason = `shape bounds=${shapeW}x${shapeH}, bitmap=${config.width}x${config.height}, pxRange=${config.pxRange}`;
      }

      throw new Error(`SDF generation failed: ${reason}`);
    }

    const numFloats = config.width * config.height * channels;
    const bitmap = new Float32Array(numFloats);
    bitmap.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + numFloats));

    m._destroyBitmap(ptr);
    return bitmap;
  }

  private getShapeBounds(shapeHandle: number): { left: number; bottom: number; right: number; top: number } {
    const m = this.module;
    const buf = m._malloc(8 * 4);
    try {
      m._getShapeBounds(shapeHandle, buf, buf + 8, buf + 16, buf + 24);
      return {
        left: m.HEAPF64[buf >> 3],
        bottom: m.HEAPF64[(buf + 8) >> 3],
        right: m.HEAPF64[(buf + 16) >> 3],
        top: m.HEAPF64[(buf + 24) >> 3],
      };
    } finally {
      m._free(buf);
    }
  }
}

export type {
  MsdfConfig,
  SdfMode,
  GlyphMetrics,
  FontMetrics,
  ShapedGlyph,
  AtlasEntry,
  AtlasRegion,
  PackedAtlas,
  PackOptions,
  FontHandle,
} from './types.js';

export { packAtlas } from './atlas-packer.js';
export { getBundledGlueUrl, getBundledWasmUrl, loadWasmModule } from './wasm-loader.js';
