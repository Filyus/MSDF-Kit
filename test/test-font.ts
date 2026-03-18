// Integration test: Font → MTSDF atlas
// Requires: WASM built (.\build.ps1) + font (.\scripts\download-test-font.ps1)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { MsdfKitWasmModule } from '../typescript/types.js';
import { loadTestWasmModule, loadTestFont } from './helpers/load-wasm.js';
import { packAtlas } from '../typescript/atlas-packer.js';

describe('font → MTSDF (integration)', () => {
  let m: MsdfKitWasmModule;
  let fontHandle: number;
  let fontDataPtr: number; // Must stay alive while font is in use (FreeType keeps a reference)

  beforeAll(async () => {
    m = await loadTestWasmModule();

    const fontData = loadTestFont();
    const bytes = new Uint8Array(fontData);
    fontDataPtr = m._malloc(bytes.length);
    m.HEAPU8.set(bytes, fontDataPtr);
    fontHandle = m._loadFont(fontDataPtr, bytes.length);
  });

  afterAll(() => {
    if (fontHandle > 0) m._destroyFont(fontHandle);
    if (fontDataPtr) m._free(fontDataPtr);
  });

  it('loads font successfully', () => {
    expect(fontHandle).toBeGreaterThan(0);
  });

  it('reads font metrics', () => {
    const buf = m._malloc(8 * 4);
    m._getFontMetrics(fontHandle, buf, buf + 8, buf + 16, buf + 24);

    const ascender = m.HEAPF64[buf >> 3];
    const descender = m.HEAPF64[(buf + 8) >> 3];
    const lineHeight = m.HEAPF64[(buf + 16) >> 3];
    const unitsPerEm = m.HEAPF64[(buf + 24) >> 3];
    m._free(buf);

    expect(ascender).toBeGreaterThan(0);
    expect(descender).toBeLessThan(0); // descender is negative
    expect(lineHeight).toBeGreaterThan(0);
    expect(unitsPerEm).toBeGreaterThan(0);
  });

  it('reads glyph metrics for "A" (codepoint 65)', () => {
    const buf = m._malloc(8 * 5);
    m._getGlyphMetrics(fontHandle, 65, buf, buf + 8, buf + 16, buf + 24, buf + 32);

    const advance = m.HEAPF64[buf >> 3];
    const left = m.HEAPF64[(buf + 8) >> 3];
    const bottom = m.HEAPF64[(buf + 16) >> 3];
    const right = m.HEAPF64[(buf + 24) >> 3];
    const top = m.HEAPF64[(buf + 32) >> 3];
    m._free(buf);

    expect(advance).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(left);
    expect(top).toBeGreaterThan(bottom);
  });

  it('creates shape from glyph "A"', () => {
    const shapeHandle = m._shapeFromGlyph(fontHandle, 65);
    expect(shapeHandle).toBeGreaterThan(0);
    m._destroyShape(shapeHandle);
  });

  it('generates MTSDF bitmap for glyph "A"', () => {
    const shapeHandle = m._shapeFromGlyph(fontHandle, 65);
    expect(shapeHandle).toBeGreaterThan(0);

    const width = 32;
    const height = 32;
    const bitmapPtr = m._generateMtsdf(shapeHandle, width, height, 4.0, 3.0, 0, 3);
    expect(bitmapPtr).toBeGreaterThan(0);

    const numFloats = width * height * 4;
    const bitmap = new Float32Array(numFloats);
    bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));

    // Bitmap should have varied content (SDF gradient from inside to outside)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < bitmap.length; i++) {
      if (bitmap[i] < min) min = bitmap[i];
      if (bitmap[i] > max) max = bitmap[i];
    }
    expect(max - min).toBeGreaterThan(0.1);

    m._destroyBitmap(bitmapPtr);
    m._destroyShape(shapeHandle);
  });

  it('generates MTSDF for multiple glyphs with varied output', () => {
    const codepoints = [65, 66, 67, 97, 98, 48, 49]; // A B C a b 0 1
    const bitmaps: Float32Array[] = [];
    const width = 32, height = 32;

    for (const cp of codepoints) {
      const shapeHandle = m._shapeFromGlyph(fontHandle, cp);
      if (shapeHandle < 0) continue;

      const bitmapPtr = m._generateMtsdf(shapeHandle, width, height, 4.0, 3.0, 0, 3);
      if (!bitmapPtr) {
        m._destroyShape(shapeHandle);
        continue;
      }

      const numFloats = width * height * 4;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));
      bitmaps.push(bitmap);

      m._destroyBitmap(bitmapPtr);
      m._destroyShape(shapeHandle);
    }

    expect(bitmaps.length).toBe(7);

    // Different glyphs should produce different bitmaps
    const sums = bitmaps.map(b => b.reduce((s, v) => s + v, 0));
    const uniqueSums = new Set(sums.map(s => Math.round(s)));
    expect(uniqueSums.size).toBeGreaterThan(1);
  });

  it('gets kerning between glyphs', () => {
    const kern = m._getKerning(fontHandle, 65, 86); // A-V
    expect(typeof kern).toBe('number');
  });

  it('full pipeline: font → glyphs → atlas', () => {
    const charset = 'ABCD';
    const width = 32, height = 32;
    const entries: Array<{ id: string; bitmap: Float32Array; width: number; height: number; channels: number }> = [];

    for (const char of charset) {
      const cp = char.codePointAt(0)!;
      const shapeHandle = m._shapeFromGlyph(fontHandle, cp);
      if (shapeHandle < 0) continue;

      const bitmapPtr = m._generateMtsdf(shapeHandle, width, height, 4.0, 3.0, 0, 3);
      if (!bitmapPtr) { m._destroyShape(shapeHandle); continue; }

      const numFloats = width * height * 4;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));

      entries.push({ id: `glyph:${cp}`, bitmap, width, height, channels: 4 });

      m._destroyBitmap(bitmapPtr);
      m._destroyShape(shapeHandle);
    }

    expect(entries.length).toBe(4);

    const atlas = packAtlas(entries);
    expect(atlas.width).toBeGreaterThan(0);
    expect(atlas.height).toBeGreaterThan(0);
    expect(atlas.regions.size).toBe(4);
    expect(atlas.textures[0].length).toBe(atlas.width * atlas.height * 4);

    // Verify atlas texture has non-zero data (bitmaps were blitted)
    let nonZero = 0;
    for (let i = 0; i < atlas.textures[0].length; i++) {
      if (atlas.textures[0][i] !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);

    // All regions within bounds
    for (const [, region] of atlas.regions) {
      expect(region.x + region.w).toBeLessThanOrEqual(atlas.width);
      expect(region.y + region.h).toBeLessThanOrEqual(atlas.height);
    }
  });

  describe('all SDF modes with font glyphs', () => {
    const MODES = [0, 1, 2, 3] as const;
    const MODE_NAMES = ['SDF', 'PSDF', 'MSDF', 'MTSDF'] as const;
    const CHANNELS = [1, 1, 3, 4];

    function generateGlyph(cp: number, mode: number): { bitmap: Float32Array; channels: number } {
      const shapeHandle = m._shapeFromGlyph(fontHandle, cp);
      if (shapeHandle < 0) throw new Error(`No shape for cp ${cp}`);

      const w = 32, h = 32, ch = CHANNELS[mode];
      const ptr = m._generateMtsdf(shapeHandle, w, h, 4.0, 3.0, 0, mode);
      if (!ptr) { m._destroyShape(shapeHandle); throw new Error(`Generation failed for mode ${mode}`); }

      const numFloats = w * h * ch;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + numFloats));
      m._destroyBitmap(ptr);
      m._destroyShape(shapeHandle);
      return { bitmap, channels: ch };
    }

    for (const mode of MODES) {
      it(`generates ${MODE_NAMES[mode]} (mode ${mode}) for glyph "A" with ${CHANNELS[mode]}ch`, () => {
        const { bitmap, channels } = generateGlyph(65, mode);
        expect(bitmap.length).toBe(32 * 32 * channels);

        // Should have value variation (inside vs outside)
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < bitmap.length; i++) {
          if (bitmap[i] < min) min = bitmap[i];
          if (bitmap[i] > max) max = bitmap[i];
        }
        expect(max - min).toBeGreaterThan(0.1);
      });
    }

    it('packs glyphs from all modes into one atlas', () => {
      const entries: Array<{ id: string; bitmap: Float32Array; width: number; height: number; channels: number }> = [];

      for (const mode of MODES) {
        const { bitmap, channels } = generateGlyph(65, mode);
        entries.push({ id: `A-${MODE_NAMES[mode]}`, bitmap, width: 32, height: 32, channels });
      }

      const atlas = packAtlas(entries);
      expect(atlas.regions.size).toBe(4);

      // Atlas texture should have non-zero data overall
      let totalNonZero = 0;
      for (let i = 0; i < atlas.textures[0].length; i++) {
        if (atlas.textures[0][i] !== 0) totalNonZero++;
      }
      expect(totalNonZero).toBeGreaterThan(0);

      // All regions within bounds
      for (const [, region] of atlas.regions) {
        expect(region.x + region.w).toBeLessThanOrEqual(atlas.width);
        expect(region.y + region.h).toBeLessThanOrEqual(atlas.height);
      }
    });
  });
});
