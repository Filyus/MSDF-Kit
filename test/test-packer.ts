import { describe, it, expect } from 'vitest';
import { packAtlas } from '../typescript/atlas-packer.js';
import type { AtlasEntry } from '../typescript/types.js';

describe('atlas-packer', () => {
  it('packs a single entry', () => {
    const entry: AtlasEntry = {
      id: 'glyph:65',
      bitmap: new Float32Array(32 * 32 * 4).fill(0.5),
      width: 32,
      height: 32,
      channels: 4,
    };

    const atlas = packAtlas([entry]);
    expect(atlas.width).toBeGreaterThanOrEqual(32);
    expect(atlas.height).toBeGreaterThanOrEqual(32);
    expect(atlas.regions.has('glyph:65')).toBe(true);

    const region = atlas.regions.get('glyph:65')!;
    expect(region.w).toBe(32);
    expect(region.h).toBe(32);
  });

  it('packs multiple entries', () => {
    const entries: AtlasEntry[] = [];
    for (let i = 0; i < 20; i++) {
      entries.push({
        id: `glyph:${65 + i}`,
        bitmap: new Float32Array(24 * 24 * 4).fill(0.5),
        width: 24,
        height: 24,
        channels: 4,
      });
    }

    const atlas = packAtlas(entries);
    expect(atlas.regions.size).toBe(20);
    expect(atlas.textures[0].length).toBe(atlas.width * atlas.height * 4);

    // All regions should be within atlas bounds
    for (const [, region] of atlas.regions) {
      expect(region.x + region.w).toBeLessThanOrEqual(atlas.width);
      expect(region.y + region.h).toBeLessThanOrEqual(atlas.height);
    }
  });

  it('respects power-of-two constraint', () => {
    const entry: AtlasEntry = {
      id: 'test',
      bitmap: new Float32Array(10 * 10 * 4),
      width: 10,
      height: 10,
      channels: 4,
    };

    const atlas = packAtlas([entry], { pot: true });
    expect(atlas.width & (atlas.width - 1)).toBe(0); // is power of two
    expect(atlas.height & (atlas.height - 1)).toBe(0);
  });

  it('converts float bitmap to uint8 correctly', () => {
    const bitmap = new Float32Array(2 * 2 * 4);
    bitmap[0] = 0.0;  // R
    bitmap[1] = 0.5;  // G
    bitmap[2] = 1.0;  // B
    bitmap[3] = 0.75; // A

    const entry: AtlasEntry = {
      id: 'pixel-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 4,
    };

    const atlas = packAtlas([entry], { padding: 0 });
    const region = atlas.regions.get('pixel-test')!;
    const base = (region.y * atlas.width + region.x) * 4;

    expect(atlas.textures[0][base + 0]).toBe(0);
    expect(atlas.textures[0][base + 1]).toBe(128);
    expect(atlas.textures[0][base + 2]).toBe(255);
    expect(atlas.textures[0][base + 3]).toBe(191);
  });

  it('throws when entries exceed max dimensions', () => {
    const entry: AtlasEntry = {
      id: 'huge',
      bitmap: new Float32Array(512 * 512 * 4),
      width: 512,
      height: 512,
      channels: 4,
    };

    expect(() =>
      packAtlas([entry], { maxWidth: 64, maxHeight: 64 })
    ).toThrow();
  });

  it('blits 1-channel bitmap to RGBA (replicated)', () => {
    const bitmap = new Float32Array(2 * 2 * 1);
    bitmap[0] = 0.0;
    bitmap[1] = 0.5;
    bitmap[2] = 1.0;
    bitmap[3] = 0.25;

    const entry: AtlasEntry = {
      id: 'sdf-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 1,
    };

    const atlas = packAtlas([entry], { padding: 0 });
    const region = atlas.regions.get('sdf-test')!;
    const base = (region.y * atlas.width + region.x) * 4;

    // 1ch → R=G=B=A=val
    expect(atlas.textures[0][base + 0]).toBe(0);
    expect(atlas.textures[0][base + 1]).toBe(0);
    expect(atlas.textures[0][base + 2]).toBe(0);
    expect(atlas.textures[0][base + 3]).toBe(0);

    // Second pixel (0.5 → 128)
    const px1 = base + 4;
    expect(atlas.textures[0][px1 + 0]).toBe(128);
    expect(atlas.textures[0][px1 + 1]).toBe(128);
    expect(atlas.textures[0][px1 + 2]).toBe(128);
    expect(atlas.textures[0][px1 + 3]).toBe(128);
  });

  it('blits 3-channel bitmap to RGBA (alpha=255)', () => {
    const bitmap = new Float32Array(2 * 2 * 3);
    bitmap[0] = 0.0;  // R
    bitmap[1] = 0.5;  // G
    bitmap[2] = 1.0;  // B
    // remaining pixels zero

    const entry: AtlasEntry = {
      id: 'msdf-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 3,
    };

    const atlas = packAtlas([entry], { padding: 0 });
    const region = atlas.regions.get('msdf-test')!;
    const base = (region.y * atlas.width + region.x) * 4;

    // 3ch → R,G,B from data, A=255
    expect(atlas.textures[0][base + 0]).toBe(0);
    expect(atlas.textures[0][base + 1]).toBe(128);
    expect(atlas.textures[0][base + 2]).toBe(255);
    expect(atlas.textures[0][base + 3]).toBe(255);
  });

  it('packs mixed-channel entries together', () => {
    const entries: AtlasEntry[] = [
      { id: 'sdf', bitmap: new Float32Array(16 * 16 * 1).fill(0.5), width: 16, height: 16, channels: 1 },
      { id: 'msdf', bitmap: new Float32Array(16 * 16 * 3).fill(0.5), width: 16, height: 16, channels: 3 },
      { id: 'mtsdf', bitmap: new Float32Array(16 * 16 * 4).fill(0.5), width: 16, height: 16, channels: 4 },
    ];

    const atlas = packAtlas(entries);
    expect(atlas.regions.size).toBe(3);
    expect(atlas.textures[0].length).toBe(atlas.width * atlas.height * 4);

    // All regions should have non-zero data blitted
    for (const [id, region] of atlas.regions) {
      const base = (region.y * atlas.width + region.x) * 4;
      // At least the first pixel should be non-zero (all filled with 0.5)
      const pixelSum = atlas.textures[0][base] + atlas.textures[0][base + 1] +
                       atlas.textures[0][base + 2] + atlas.textures[0][base + 3];
      expect(pixelSum).toBeGreaterThan(0);
    }
  });

  it('single-page result has textures array and page field', () => {
    const entry: AtlasEntry = {
      id: 'compat',
      bitmap: new Float32Array(16 * 16 * 4).fill(0.5),
      width: 16,
      height: 16,
      channels: 4,
    };

    const atlas = packAtlas([entry]);
    expect(atlas.textures).toHaveLength(1);
    expect(atlas.atlasFormat).toBe('rgba8');
    expect(atlas.regions.get('compat')!.page).toBe(0);
  });

  it('can pack into float32 atlas pages', () => {
    const bitmap = new Float32Array(2 * 2 * 4);
    bitmap[0] = -1.25;
    bitmap[1] = 0.5;
    bitmap[2] = 1.75;
    bitmap[3] = 0.75;

    const entry: AtlasEntry = {
      id: 'float-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 4,
    };

    const atlas = packAtlas([entry], { padding: 0, atlasFormat: 'rgba32f' });
    expect(atlas.atlasFormat).toBe('rgba32f');
    expect(atlas.textures).toHaveLength(1);
    expect(atlas.textures[0]).toBeInstanceOf(Float32Array);

    const region = atlas.regions.get('float-test')!;
    const base = (region.y * atlas.width + region.x) * 4;
    const tex = atlas.textures[0] as Float32Array;
    expect(tex[base + 0]).toBeCloseTo(-1.25);
    expect(tex[base + 1]).toBeCloseTo(0.5);
    expect(tex[base + 2]).toBeCloseTo(1.75);
    expect(tex[base + 3]).toBeCloseTo(0.75);
  });

  it('can pack into rgba16f atlas pages', () => {
    const bitmap = new Float32Array(2 * 2 * 4);
    bitmap[0] = -1.25;
    bitmap[1] = 0.5;
    bitmap[2] = 1.75;
    bitmap[3] = 0.75;

    const entry: AtlasEntry = {
      id: 'half-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 4,
    };

    const atlas = packAtlas([entry], { padding: 0, atlasFormat: 'rgba16f' });
    expect(atlas.atlasFormat).toBe('rgba16f');
    expect(atlas.textures).toHaveLength(1);
    expect(atlas.textures[0]).toBeInstanceOf(Float32Array);

    const region = atlas.regions.get('half-test')!;
    const base = (region.y * atlas.width + region.x) * 4;
    const tex = atlas.textures[0] as Float32Array;
    expect(tex[base + 0]).toBeCloseTo(-1.25);
    expect(tex[base + 1]).toBeCloseTo(0.5);
    expect(tex[base + 2]).toBeCloseTo(1.75);
    expect(tex[base + 3]).toBeCloseTo(0.75);
  });

  it('fills alpha as 1.0 for 3-channel float32 atlas entries', () => {
    const bitmap = new Float32Array(2 * 2 * 3);
    bitmap[0] = 0.1;
    bitmap[1] = 0.2;
    bitmap[2] = 0.3;

    const entry: AtlasEntry = {
      id: 'float-msdf-test',
      bitmap,
      width: 2,
      height: 2,
      channels: 3,
    };

    const atlas = packAtlas([entry], { padding: 0, atlasFormat: 'rgba32f' });
    const region = atlas.regions.get('float-msdf-test')!;
    const base = (region.y * atlas.width + region.x) * 4;
    const tex = atlas.textures[0] as Float32Array;
    expect(tex[base + 0]).toBeCloseTo(0.1);
    expect(tex[base + 1]).toBeCloseTo(0.2);
    expect(tex[base + 2]).toBeCloseTo(0.3);
    expect(tex[base + 3]).toBeCloseTo(1.0);
  });

  it('passes pxRange through to result', () => {
    const entry: AtlasEntry = {
      id: 'px',
      bitmap: new Float32Array(8 * 8 * 4),
      width: 8,
      height: 8,
      channels: 4,
    };

    const atlas = packAtlas([entry], { pxRange: 6 });
    expect(atlas.pxRange).toBe(6);
  });

  it('defaults pxRange to 4', () => {
    const entry: AtlasEntry = {
      id: 'px-default',
      bitmap: new Float32Array(8 * 8 * 4),
      width: 8,
      height: 8,
      channels: 4,
    };

    const atlas = packAtlas([entry]);
    expect(atlas.pxRange).toBe(4);
  });

  it('packs into multiple pages when entries exceed single page', () => {
    // 4 entries of 200x200, each needs 201x201 with padding
    // A 256x256 page fits only 1 entry (201*2 = 402 > 256)
    const entries: AtlasEntry[] = [];
    for (let i = 0; i < 4; i++) {
      entries.push({
        id: `big:${i}`,
        bitmap: new Float32Array(200 * 200 * 4).fill(0.5),
        width: 200,
        height: 200,
        channels: 4,
      });
    }

    const atlas = packAtlas(entries, { maxWidth: 256, maxHeight: 256 });

    // Should use multiple pages (4 entries, 1 per page)
    expect(atlas.textures.length).toBe(4);
    expect(atlas.regions.size).toBe(4);
    expect(atlas.width).toBe(256);
    expect(atlas.height).toBe(256);

    // Each region on a valid page with valid coords
    for (const [, region] of atlas.regions) {
      expect(region.page).toBeGreaterThanOrEqual(0);
      expect(region.page).toBeLessThan(atlas.textures.length);
      expect(region.x + region.w).toBeLessThanOrEqual(atlas.width);
      expect(region.y + region.h).toBeLessThanOrEqual(atlas.height);
    }

    // Verify pixel data was blitted to each page
    for (let p = 0; p < atlas.textures.length; p++) {
      const tex = atlas.textures[p];
      // At least some non-zero pixels
      let sum = 0;
      for (let i = 0; i < Math.min(tex.length, 1000); i++) sum += tex[i];
      expect(sum).toBeGreaterThan(0);
    }
  });
});
