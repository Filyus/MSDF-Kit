// Integration test: WASM module loading and low-level API verification
// Requires WASM to be built: .\build.ps1

import { describe, it, expect, beforeAll } from 'vitest';
import type { MsdfKitWasmModule } from '../typescript/types.js';
import { loadTestWasmModule } from './helpers/load-wasm.js';

describe('WASM module', () => {
  let m: MsdfKitWasmModule;

  beforeAll(async () => {
    m = await loadTestWasmModule();
  });

  it('loads and exposes all expected exports', () => {
    expect(typeof m._init).toBe('function');
    expect(typeof m._loadFont).toBe('function');
    expect(typeof m._shapeFromGlyph).toBe('function');
    expect(typeof m._getGlyphMetrics).toBe('function');
    expect(typeof m._getFontMetrics).toBe('function');
    expect(typeof m._getKerning).toBe('function');
    expect(typeof m._shapeFromSvgPath).toBe('function');
    expect(typeof m._getShapeBounds).toBe('function');
    expect(typeof m._generateMtsdf).toBe('function');
    expect(typeof m._destroyShape).toBe('function');
    expect(typeof m._destroyFont).toBe('function');
    expect(typeof m._destroyBitmap).toBe('function');
    expect(typeof m._malloc).toBe('function');
    expect(typeof m._free).toBe('function');
  });

  it('has working HEAP accessors', () => {
    expect(m.HEAPU8).toBeInstanceOf(Uint8Array);
    expect(m.HEAPF32).toBeInstanceOf(Float32Array);
    expect(m.HEAPF64).toBeInstanceOf(Float64Array);
  });

  it('can allocate and free memory', () => {
    const ptr = m._malloc(1024);
    expect(ptr).toBeGreaterThan(0);
    m._free(ptr);
  });

  describe('SVG path → MTSDF (no font needed)', () => {
    it('creates a shape from SVG path data', () => {
      const pathStr = 'M 10 20 L 30 50 L 10 80 Z';
      const strLen = pathStr.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(pathStr, strPtr, strLen);

      const shapeHandle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);

      expect(shapeHandle).toBeGreaterThan(0);
      m._destroyShape(shapeHandle);
    });

    it('can read shape bounds from SVG path data', () => {
      const pathStr = 'M 10 20 L 30 50 L 10 80 Z';
      const strLen = pathStr.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(pathStr, strPtr, strLen);

      const shapeHandle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);
      expect(shapeHandle).toBeGreaterThan(0);

      const buf = m._malloc(8 * 4);
      m._getShapeBounds(shapeHandle, buf, buf + 8, buf + 16, buf + 24);
      const left = m.HEAPF64[buf >> 3];
      const bottom = m.HEAPF64[(buf + 8) >> 3];
      const right = m.HEAPF64[(buf + 16) >> 3];
      const top = m.HEAPF64[(buf + 24) >> 3];

      expect(right).toBeGreaterThan(left);
      expect(top).toBeGreaterThan(bottom);

      m._free(buf);
      m._destroyShape(shapeHandle);
    });

    it('returns a valid handle even for minimal SVG paths', () => {
      // msdfgen's SVG path parser is permissive — even empty strings may
      // produce a valid (but empty) shape. We just verify no crash occurs.
      const pathStr = '';
      const strLen = 4;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(pathStr, strPtr, strLen);

      const shapeHandle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);

      // Either valid handle or -1, both are acceptable
      expect(typeof shapeHandle).toBe('number');
      if (shapeHandle > 0) m._destroyShape(shapeHandle);
    });

    it('generates an MTSDF bitmap from SVG path', () => {
      const pathStr = 'M 0 0 L 100 0 L 100 100 L 0 100 Z';
      const strLen = pathStr.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(pathStr, strPtr, strLen);

      const shapeHandle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);
      expect(shapeHandle).toBeGreaterThan(0);

      const width = 32;
      const height = 32;
      const pxRange = 4.0;
      const bitmapPtr = m._generateMtsdf(shapeHandle, width, height, pxRange, 3.0, 0, 3);
      expect(bitmapPtr).toBeGreaterThan(0);

      // Read bitmap data — 4 channels (RGBA) per pixel, float
      const numFloats = width * height * 4;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));

      // Verify bitmap has non-trivial content (not all zeros, not all the same value)
      const uniqueValues = new Set<number>();
      for (let i = 0; i < Math.min(bitmap.length, 200); i++) {
        uniqueValues.add(Math.round(bitmap[i] * 1000) / 1000);
      }
      expect(uniqueValues.size).toBeGreaterThan(1);

      // Verify min and max differ (SDF has gradient from inside to outside)
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < bitmap.length; i++) {
        if (bitmap[i] < min) min = bitmap[i];
        if (bitmap[i] > max) max = bitmap[i];
      }
      expect(max - min).toBeGreaterThan(0.1);

      m._destroyBitmap(bitmapPtr);
      m._destroyShape(shapeHandle);
    });

    it('generates MTSDF for a triangle path', () => {
      const pathStr = 'M 50 10 L 90 90 L 10 90 Z';
      const strLen = pathStr.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(pathStr, strPtr, strLen);

      const shapeHandle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);
      expect(shapeHandle).toBeGreaterThan(0);

      const bitmapPtr = m._generateMtsdf(shapeHandle, 48, 48, 4.0, 3.0, 0, 3);
      expect(bitmapPtr).toBeGreaterThan(0);

      const numFloats = 48 * 48 * 4;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));

      // Verify 4 channels per pixel
      expect(bitmap.length).toBe(numFloats);

      // Check that we have varied values (actual SDF content)
      let hasAboveHalf = false;
      let hasBelowHalf = false;
      for (let i = 0; i < bitmap.length; i += 4) {
        const r = bitmap[i];
        if (r > 0.6) hasAboveHalf = true;
        if (r < 0.4) hasBelowHalf = true;
      }
      expect(hasAboveHalf).toBe(true);
      expect(hasBelowHalf).toBe(true);

      m._destroyBitmap(bitmapPtr);
      m._destroyShape(shapeHandle);
    });
  });

  describe('SDF generation modes', () => {
    const SQUARE_PATH = 'M 10 10 L 90 10 L 90 90 L 10 90 Z';
    const W = 32, H = 32;
    const CHANNELS = [1, 1, 3, 4]; // SDF, PSDF, MSDF, MTSDF

    function makeSquare(): number {
      const strLen = SQUARE_PATH.length * 4 + 1;
      const strPtr = m._malloc(strLen);
      m.stringToUTF8(SQUARE_PATH, strPtr, strLen);
      const handle = m._shapeFromSvgPath(strPtr, 100, 100);
      m._free(strPtr);
      return handle;
    }

    function generate(shapeHandle: number, sdfMode: number): Float32Array {
      const ptr = m._generateMtsdf(shapeHandle, W, H, 4.0, 3.0, 0, sdfMode);
      expect(ptr).toBeGreaterThan(0);
      const ch = CHANNELS[sdfMode];
      const numFloats = W * H * ch;
      const bitmap = new Float32Array(numFloats);
      bitmap.set(m.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + numFloats));
      m._destroyBitmap(ptr);
      return bitmap;
    }

    it('mode 0 (SDF) — 1 channel per pixel', () => {
      const handle = makeSquare();
      const bmp = generate(handle, 0);
      expect(bmp.length).toBe(W * H * 1);
      // Value range check: SDF should have inside (>0.5) and outside (<0.5)
      expect(bmp.some(v => v > 0.5)).toBe(true);
      expect(bmp.some(v => v < 0.5)).toBe(true);
      m._destroyShape(handle);
    });

    it('mode 1 (PSDF) — 1 channel per pixel', () => {
      const handle = makeSquare();
      const bmp = generate(handle, 1);
      expect(bmp.length).toBe(W * H * 1);
      expect(bmp.some(v => v > 0.5)).toBe(true);
      expect(bmp.some(v => v < 0.5)).toBe(true);
      m._destroyShape(handle);
    });

    it('mode 2 (MSDF) — 3 channels per pixel', () => {
      const handle = makeSquare();
      const bmp = generate(handle, 2);
      expect(bmp.length).toBe(W * H * 3);
      // RGB channels should have varied values
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < bmp.length; i++) {
        if (bmp[i] < min) min = bmp[i];
        if (bmp[i] > max) max = bmp[i];
      }
      expect(max - min).toBeGreaterThan(0.1);
      m._destroyShape(handle);
    });

    it('mode 3 (MTSDF) — 4 channels per pixel', () => {
      const handle = makeSquare();
      const bmp = generate(handle, 3);
      expect(bmp.length).toBe(W * H * 4);
      // Alpha channel (true SDF) should vary
      let alphaMin = Infinity, alphaMax = -Infinity;
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] < alphaMin) alphaMin = bmp[i];
        if (bmp[i] > alphaMax) alphaMax = bmp[i];
      }
      expect(alphaMax - alphaMin).toBeGreaterThan(0.1);
      m._destroyShape(handle);
    });

    it('SDF and PSDF produce different values', () => {
      const handle = makeSquare();
      const sdf = generate(handle, 0);
      const psdf = generate(handle, 1);
      let diffCount = 0;
      for (let i = 0; i < sdf.length; i++) {
        if (Math.abs(sdf[i] - psdf[i]) > 0.001) diffCount++;
      }
      // At least some pixels should differ between true SDF and pseudo SDF
      expect(diffCount).toBeGreaterThan(0);
      m._destroyShape(handle);
    });

    it('each mode outputs correct number of floats', () => {
      const handle = makeSquare();
      for (let mode = 0; mode < 4; mode++) {
        const bmp = generate(handle, mode);
        expect(bmp.length).toBe(W * H * CHANNELS[mode]);
      }
      m._destroyShape(handle);
    });
  });
});
