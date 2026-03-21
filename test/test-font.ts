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

  // ── HarfBuzz shaping ───────────────────────────────────────────

  describe('HarfBuzz text shaping', () => {
    function layoutText(text: string) {
      const strLen = text.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(text, strPtr, strLen);
      const countPtr = m._malloc(4);
      const ptr = m._layoutText(fontHandle, strPtr, countPtr);
      m._free(strPtr);
      if (!ptr) { m._free(countPtr); return []; }
      const count = m.getValue(countPtr, 'i32');
      m._free(countPtr);
      const result: Array<{ glyphId: number; xOffset: number; yOffset: number; xAdvance: number; yAdvance: number; cluster: number }> = [];
      for (let i = 0; i < count; i++) {
        const base = (ptr >> 2) + i * 6;
        result.push({
          glyphId:  m.HEAPF32[base],
          xOffset:  m.HEAPF32[base + 1],
          yOffset:  m.HEAPF32[base + 2],
          xAdvance: m.HEAPF32[base + 3],
          yAdvance: m.HEAPF32[base + 4],
          cluster:  m.HEAPF32[base + 5],
        });
      }
      m._free(ptr);
      return result;
    }

    it('shapes "Hello" and returns correct glyph count', () => {
      const glyphs = layoutText('Hello');
      expect(glyphs.length).toBe(5);
    });

    it('all shaped glyphs have positive glyph IDs', () => {
      const glyphs = layoutText('ABC');
      expect(glyphs.every(g => g.glyphId > 0)).toBe(true);
    });

    it('all shaped glyphs have positive x advances', () => {
      const glyphs = layoutText('Hello');
      expect(glyphs.every(g => g.xAdvance > 0)).toBe(true);
    });

    it('advances are EM-normalised (< 1.5 for typical glyphs)', () => {
      const glyphs = layoutText('ABC');
      expect(glyphs.every(g => g.xAdvance < 1.5)).toBe(true);
    });

    it('different characters produce different glyph IDs', () => {
      const glyphs = layoutText('AB');
      expect(glyphs[0].glyphId).not.toBe(glyphs[1].glyphId);
    });

    it('repeated character produces the same glyph ID', () => {
      const glyphs = layoutText('AA');
      expect(glyphs[0].glyphId).toBe(glyphs[1].glyphId);
    });

    it('shapeFromGlyphId creates a valid shape for a shaped glyph', () => {
      const [g] = layoutText('A');
      expect(g).toBeDefined();
      const shapeHandle = m._shapeFromGlyphId(fontHandle, g.glyphId);
      expect(shapeHandle).toBeGreaterThan(0);
      m._destroyShape(shapeHandle);
    });

    it('shapeFromGlyphId renders the same bitmap as shapeFromGlyph for ASCII', () => {
      const [g] = layoutText('A');
      const w = 32, h = 32;

      const shById  = m._shapeFromGlyphId(fontHandle, g.glyphId);
      const shByCp  = m._shapeFromGlyph(fontHandle, 65);
      expect(shById).toBeGreaterThan(0);
      expect(shByCp).toBeGreaterThan(0);

      const ptrById = m._generateMtsdf(shById, w, h, 4.0, 3.0, 0, 3);
      const ptrByCp = m._generateMtsdf(shByCp, w, h, 4.0, 3.0, 0, 3);

      const n = w * h * 4;
      const bmpById = new Float32Array(n);
      const bmpByCp = new Float32Array(n);
      bmpById.set(m.HEAPF32.subarray(ptrById >> 2, (ptrById >> 2) + n));
      bmpByCp.set(m.HEAPF32.subarray(ptrByCp >> 2, (ptrByCp >> 2) + n));

      let maxDiff = 0;
      for (let i = 0; i < n; i++)
        maxDiff = Math.max(maxDiff, Math.abs(bmpById[i] - bmpByCp[i]));
      expect(maxDiff).toBeLessThan(0.001);

      m._destroyBitmap(ptrById); m._destroyShape(shById);
      m._destroyBitmap(ptrByCp); m._destroyShape(shByCp);
    });

    it('cluster values are sequential byte offsets for ASCII text', () => {
      const text = 'ABCDE';
      const glyphs = layoutText(text);
      expect(glyphs.length).toBe(5);
      // For ASCII, each char is 1 byte → cluster = char index
      for (let i = 0; i < glyphs.length; i++)
        expect(glyphs[i].cluster).toBe(i);
    });

    it('cluster correctly maps glyphs back to source characters', () => {
      const text = 'Hello';
      const encoder = new TextEncoder();
      const bytes = encoder.encode(text);
      const glyphs = layoutText(text);
      expect(glyphs.length).toBe(5);

      // Each cluster is a valid byte offset into the source string
      for (const g of glyphs) {
        expect(g.cluster).toBeGreaterThanOrEqual(0);
        expect(g.cluster).toBeLessThan(bytes.length);
      }

      // Reconstructed chars via cluster match original string chars
      const decoder = new TextDecoder();
      for (let i = 0; i < glyphs.length; i++) {
        const charFromCluster = decoder.decode(bytes.slice(glyphs[i].cluster, glyphs[i].cluster + 1));
        expect(charFromCluster).toBe(text[i]);
      }
    });

    it('yOffset is zero for all glyphs in plain Latin text (baseline alignment)', () => {
      const glyphs = layoutText('Hello World');
      // For horizontal LTR Latin, HarfBuzz sets yOffset=0 — all glyphs sit on the baseline
      expect(glyphs.every(g => g.yOffset === 0)).toBe(true);
    });

    it('glyph bounds stay within font ascender/descender (vertical alignment)', () => {
      const metBuf = m._malloc(8 * 4);
      m._getFontMetrics(fontHandle, metBuf, metBuf + 8, metBuf + 16, metBuf + 24);
      const ascender  = m.HEAPF64[metBuf >> 3];
      const descender = m.HEAPF64[(metBuf + 8) >> 3];
      m._free(metBuf);

      // Check a set of typical glyphs
      for (const cp of [65, 66, 103, 112, 121]) { // A B g p y (descenders included)
        const buf = m._malloc(8 * 5);
        m._getGlyphMetrics(fontHandle, cp, buf, buf + 8, buf + 16, buf + 24, buf + 32);
        const bottom = m.HEAPF64[(buf + 16) >> 3];
        const top    = m.HEAPF64[(buf + 32) >> 3];
        m._free(buf);

        expect(top).toBeLessThanOrEqual(ascender + 0.01);   // top within ascender
        expect(bottom).toBeGreaterThanOrEqual(descender - 0.01); // bottom within descender
      }
    });

    it('pen advances accumulate to a positive total width', () => {
      const glyphs = layoutText('Hello');
      const totalAdvance = glyphs.reduce((sum, g) => sum + g.xAdvance, 0);
      // 5 glyphs with typical advance ~0.5 em each → total > 1 em
      expect(totalAdvance).toBeGreaterThan(1.0);
    });

    it('full shaped pipeline: layoutText → shapeFromGlyphId → atlas', () => {
      const text = 'Hi!';
      const glyphs = layoutText(text);
      expect(glyphs.length).toBe(3);

      const w = 32, h = 32;
      const seen = new Map<number, { id: string; bitmap: Float32Array; width: number; height: number; channels: number }>();

      for (const g of glyphs) {
        if (seen.has(g.glyphId)) continue;
        const shapeHandle = m._shapeFromGlyphId(fontHandle, g.glyphId);
        expect(shapeHandle).toBeGreaterThan(0);
        const ptr = m._generateMtsdf(shapeHandle, w, h, 4.0, 3.0, 0, 3);
        expect(ptr).toBeGreaterThan(0);
        const bitmap = new Float32Array(w * h * 4);
        bitmap.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + w * h * 4));
        seen.set(g.glyphId, { id: `g${g.glyphId}`, bitmap, width: w, height: h, channels: 4 });
        m._destroyBitmap(ptr);
        m._destroyShape(shapeHandle);
      }

      const atlas = packAtlas([...seen.values()]);
      expect(atlas.regions.size).toBe(seen.size);
      for (const g of glyphs)
        expect(atlas.regions.has(`g${g.glyphId}`)).toBe(true);
    });
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
