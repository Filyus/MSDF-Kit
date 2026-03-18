// Integration test: SVG path → MTSDF
// Requires WASM to be built: .\build.ps1

import { describe, it, expect, beforeAll } from 'vitest';
import type { MsdfKitWasmModule } from '../typescript/types.js';
import { loadTestWasmModule } from './helpers/load-wasm.js';
import { packAtlas } from '../typescript/atlas-packer.js';
import type { AtlasEntry } from '../typescript/types.js';

function makeShape(m: MsdfKitWasmModule, pathStr: string, vbW: number, vbH: number): number {
  const strLen = pathStr.length * 4 + 1;
  const strPtr = m._malloc(strLen);
  m.stringToUTF8(pathStr, strPtr, strLen);
  const handle = m._shapeFromSvgPath(strPtr, vbW, vbH);
  m._free(strPtr);
  return handle;
}

function generateBitmap(m: MsdfKitWasmModule, shapeHandle: number, width: number, height: number, sdfMode: number = 3): Float32Array {
  const channels = [1, 1, 3, 4][sdfMode];
  const bitmapPtr = m._generateMtsdf(shapeHandle, width, height, 4.0, 3.0, 0, sdfMode);
  if (!bitmapPtr) throw new Error('generateMtsdf returned null');
  const numFloats = width * height * channels;
  const bitmap = new Float32Array(numFloats);
  bitmap.set(m.HEAPF32.subarray(bitmapPtr >> 2, (bitmapPtr >> 2) + numFloats));
  m._destroyBitmap(bitmapPtr);
  return bitmap;
}

describe('SVG → MTSDF (integration)', () => {
  let m: MsdfKitWasmModule;

  beforeAll(async () => {
    m = await loadTestWasmModule();
  });

  it('generates MTSDF from simple arrow path', () => {
    const handle = makeShape(m, 'M 10 20 L 30 50 L 10 80 Z', 100, 100);
    expect(handle).toBeGreaterThan(0);

    const bitmap = generateBitmap(m, handle, 48, 48);
    expect(bitmap.length).toBe(48 * 48 * 4);

    // SDF values should vary (inside vs outside the arrow shape)
    expect(bitmap.some(v => v > 0.5)).toBe(true);
    expect(bitmap.some(v => v < 0.5)).toBe(true);

    m._destroyShape(handle);
  });

  it('generates MTSDF from circle-like path (curves)', () => {
    // Approximate circle via cubic beziers
    const path = 'M 50 0 C 77.6 0 100 22.4 100 50 C 100 77.6 77.6 100 50 100 C 22.4 100 0 77.6 0 50 C 0 22.4 22.4 0 50 0 Z';
    const handle = makeShape(m, path, 100, 100);
    expect(handle).toBeGreaterThan(0);

    const bitmap = generateBitmap(m, handle, 64, 64);

    // Verify we got varied SDF content (gradient from inside to outside)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < bitmap.length; i++) {
      if (bitmap[i] < min) min = bitmap[i];
      if (bitmap[i] > max) max = bitmap[i];
    }
    // Center and corner should have different values (SDF varies across the shape)
    expect(max - min).toBeGreaterThan(0.1);

    m._destroyShape(handle);
  });

  it('supports different bitmap sizes', () => {
    const handle = makeShape(m, 'M 0 0 L 100 0 L 100 100 L 0 100 Z', 100, 100);
    expect(handle).toBeGreaterThan(0);

    for (const size of [16, 32, 64]) {
      const bitmap = generateBitmap(m, handle, size, size);
      expect(bitmap.length).toBe(size * size * 4);
    }

    m._destroyShape(handle);
  });

  it('supports different edge coloring modes', () => {
    const handle = makeShape(m, 'M 10 10 L 90 10 L 90 90 L 10 90 Z', 100, 100);
    expect(handle).toBeGreaterThan(0);

    // Mode 0 = simple, 1 = inkTrap, 2 = byDistance
    for (const mode of [0, 1, 2]) {
      const bitmapPtr = m._generateMtsdf(handle, 32, 32, 4.0, 3.0, mode, 3);
      expect(bitmapPtr).toBeGreaterThan(0);
      m._destroyBitmap(bitmapPtr);
    }

    m._destroyShape(handle);
  });

  it('packs multiple SVG icons into an atlas', () => {
    const paths = [
      'M 10 20 L 30 50 L 10 80 Z',                                     // arrow
      'M 0 0 L 100 0 L 100 100 L 0 100 Z',                              // square
      'M 50 0 L 100 100 L 0 100 Z',                                      // triangle
      'M 50 0 C 77.6 0 100 22.4 100 50 C 100 77.6 77.6 100 50 100 C 22.4 100 0 77.6 0 50 C 0 22.4 22.4 0 50 0 Z', // circle
    ];

    const entries: AtlasEntry[] = [];
    for (let i = 0; i < paths.length; i++) {
      const handle = makeShape(m, paths[i], 100, 100);
      expect(handle).toBeGreaterThan(0);

      const bitmap = generateBitmap(m, handle, 48, 48);
      entries.push({ id: `icon:${i}`, bitmap, width: 48, height: 48, channels: 4 });
      m._destroyShape(handle);
    }

    const atlas = packAtlas(entries);
    expect(atlas.regions.size).toBe(4);
    expect(atlas.textures[0].length).toBe(atlas.width * atlas.height * 4);

    // Verify texture has non-zero data
    let nonZero = 0;
    for (let i = 0; i < atlas.textures[0].length; i++) {
      if (atlas.textures[0][i] !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);

    // No region overlaps
    const regionArr = [...atlas.regions.values()];
    for (let i = 0; i < regionArr.length; i++) {
      for (let j = i + 1; j < regionArr.length; j++) {
        const a = regionArr[i], b = regionArr[j];
        const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
                          a.y + a.h <= b.y || b.y + b.h <= a.y);
        expect(overlap).toBe(false);
      }
    }
  });

  describe('all SDF modes with SVG paths', () => {
    const MODES = [0, 1, 2, 3] as const;
    const MODE_NAMES = ['SDF', 'PSDF', 'MSDF', 'MTSDF'] as const;
    const CHANNELS = [1, 1, 3, 4];
    const SQUARE = 'M 10 10 L 90 10 L 90 90 L 10 90 Z';

    for (const mode of MODES) {
      it(`generates ${MODE_NAMES[mode]} (mode ${mode}) from SVG with ${CHANNELS[mode]}ch`, () => {
        const handle = makeShape(m, SQUARE, 100, 100);
        expect(handle).toBeGreaterThan(0);

        const bitmap = generateBitmap(m, handle, 32, 32, mode);
        expect(bitmap.length).toBe(32 * 32 * CHANNELS[mode]);

        // All modes should produce varied values
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < bitmap.length; i++) {
          if (bitmap[i] < min) min = bitmap[i];
          if (bitmap[i] > max) max = bitmap[i];
        }
        expect(max - min).toBeGreaterThan(0.1);

        m._destroyShape(handle);
      });
    }

    it('packs SVG icons from all modes into one atlas', () => {
      const entries: AtlasEntry[] = [];

      for (const mode of MODES) {
        const handle = makeShape(m, SQUARE, 100, 100);
        expect(handle).toBeGreaterThan(0);

        const bitmap = generateBitmap(m, handle, 32, 32, mode);
        entries.push({
          id: `icon-${MODE_NAMES[mode]}`,
          bitmap,
          width: 32,
          height: 32,
          channels: CHANNELS[mode],
        });
        m._destroyShape(handle);
      }

      const atlas = packAtlas(entries);
      expect(atlas.regions.size).toBe(4);

      // Every region should have non-zero RGBA data
      for (const [, region] of atlas.regions) {
        let nonZero = 0;
        for (let y = 0; y < region.h; y++) {
          for (let x = 0; x < region.w; x++) {
            const idx = ((region.y + y) * atlas.width + (region.x + x)) * 4;
            for (let c = 0; c < 4; c++) {
              if (atlas.textures[0][idx + c] !== 0) nonZero++;
            }
          }
        }
        expect(nonZero).toBeGreaterThan(0);
      }
    });
  });
});
