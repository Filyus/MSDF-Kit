import type { AtlasEntry, AtlasRegion, AtlasTextureFormat, PackedAtlas, PackOptions } from './types.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getTextureChannels(atlasFormat: AtlasTextureFormat): number {
  return atlasFormat === 'r8' || atlasFormat === 'r32f' ? 1 : 4;
}

function isByteFormat(atlasFormat: AtlasTextureFormat): boolean {
  return atlasFormat === 'r8' || atlasFormat === 'rgba8';
}

/**
 * MaxRects bin-packing algorithm (Best Short Side Fit).
 * Pure TypeScript, no dependencies.
 */
class MaxRectsPacker {
  private width: number;
  private height: number;
  private freeRects: Rect[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.freeRects = [{ x: 0, y: 0, w: width, h: height }];
  }

  insert(w: number, h: number): Rect | null {
    let bestRect: Rect | null = null;
    let bestShortSide = Infinity;
    let bestLongSide = Infinity;
    let bestIndex = -1;

    for (let i = 0; i < this.freeRects.length; i++) {
      const fr = this.freeRects[i];
      if (w <= fr.w && h <= fr.h) {
        const shortSide = Math.min(fr.w - w, fr.h - h);
        const longSide = Math.max(fr.w - w, fr.h - h);
        if (shortSide < bestShortSide ||
            (shortSide === bestShortSide && longSide < bestLongSide)) {
          bestRect = { x: fr.x, y: fr.y, w, h };
          bestShortSide = shortSide;
          bestLongSide = longSide;
          bestIndex = i;
        }
      }
    }

    if (!bestRect || bestIndex < 0) return null;

    this.splitFreeRect(bestIndex, bestRect);
    this.pruneFreeRects();

    return bestRect;
  }

  private splitFreeRect(index: number, placed: Rect): void {
    const newFree: Rect[] = [];

    for (let i = this.freeRects.length - 1; i >= 0; i--) {
      const fr = this.freeRects[i];

      // Check overlap
      if (placed.x >= fr.x + fr.w || placed.x + placed.w <= fr.x ||
          placed.y >= fr.y + fr.h || placed.y + placed.h <= fr.y) {
        continue;
      }

      // Remove the overlapping free rect and generate up to 4 new ones
      this.freeRects.splice(i, 1);

      // Left
      if (placed.x > fr.x) {
        newFree.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
      }
      // Right
      if (placed.x + placed.w < fr.x + fr.w) {
        newFree.push({
          x: placed.x + placed.w, y: fr.y,
          w: (fr.x + fr.w) - (placed.x + placed.w), h: fr.h
        });
      }
      // Top
      if (placed.y + placed.h < fr.y + fr.h) {
        newFree.push({
          x: fr.x, y: placed.y + placed.h,
          w: fr.w, h: (fr.y + fr.h) - (placed.y + placed.h)
        });
      }
      // Bottom
      if (placed.y > fr.y) {
        newFree.push({ x: fr.x, y: fr.y, w: fr.w, h: placed.y - fr.y });
      }
    }

    this.freeRects.push(...newFree);
  }

  private pruneFreeRects(): void {
    for (let i = 0; i < this.freeRects.length; i++) {
      for (let j = i + 1; j < this.freeRects.length; j++) {
        if (this.contains(this.freeRects[j], this.freeRects[i])) {
          this.freeRects.splice(i, 1);
          i--;
          break;
        }
        if (this.contains(this.freeRects[i], this.freeRects[j])) {
          this.freeRects.splice(j, 1);
          j--;
        }
      }
    }
  }

  private contains(a: Rect, b: Rect): boolean {
    return b.x >= a.x && b.y >= a.y &&
           b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  }
}

function nextPowerOfTwo(n: number): number {
  n--;
  n |= n >> 1;
  n |= n >> 2;
  n |= n >> 4;
  n |= n >> 8;
  n |= n >> 16;
  return n + 1;
}

/**
 * Pack multiple AtlasEntry items into a texture atlas.
 * Supports multi-page overflow when entries exceed a single page.
 */
export function packAtlas(entries: AtlasEntry[], options?: PackOptions): PackedAtlas {
  const maxW = options?.maxWidth ?? 2048;
  const maxH = options?.maxHeight ?? 2048;
  const padding = options?.padding ?? 1;
  const pot = options?.pot ?? true;
  const pxRange = options?.pxRange ?? 4;
  const atlasFormat = options?.atlasFormat ?? 'rgba8';
  const textureChannels = getTextureChannels(atlasFormat);

  for (const entry of entries) {
    if (textureChannels === 1 && entry.channels !== 1) {
      throw new Error(
        `Atlas format "${atlasFormat}" only supports single-channel entries, got ${entry.id} with ${entry.channels} channels`
      );
    }
  }

  // Sort entries by height descending for better packing
  const sorted = [...entries].sort((a, b) => b.height - a.height);

  // --- Single-page fast path with auto-grow ---
  let totalArea = 0;
  for (const entry of sorted) {
    totalArea += (entry.width + padding) * (entry.height + padding);
  }
  let estSide = Math.ceil(Math.sqrt(totalArea));
  if (pot) estSide = nextPowerOfTwo(estSide);
  let atlasW = Math.min(estSide, maxW);
  let atlasH = Math.min(estSide, maxH);

  for (let attempt = 0; attempt < 8; attempt++) {
    const packer = new MaxRectsPacker(atlasW, atlasH);
    const placements: Array<{ entry: AtlasEntry; rect: Rect }> = [];
    let allFit = true;

    for (const entry of sorted) {
      const rect = packer.insert(entry.width + padding, entry.height + padding);
      if (!rect) { allFit = false; break; }
      placements.push({ entry, rect });
    }

    if (allFit) {
      const regions = new Map<string, AtlasRegion>();
      const texture = createTexture(atlasW, atlasH, atlasFormat);
      for (const { entry, rect } of placements) {
        regions.set(entry.id, {
          x: rect.x, y: rect.y, w: entry.width, h: entry.height,
          id: entry.id, page: 0,
        });
        blitEntry(entry, rect, texture, atlasW, atlasFormat);
      }
      return { textures: [texture], atlasFormat, width: atlasW, height: atlasH, regions, pxRange };
    }

    // Grow atlas
    if (atlasW <= atlasH && atlasW * 2 <= maxW) {
      atlasW = pot ? atlasW * 2 : Math.min(atlasW + estSide, maxW);
    } else if (atlasH * 2 <= maxH) {
      atlasH = pot ? atlasH * 2 : Math.min(atlasH + estSide, maxH);
    } else {
      break; // At max size, need multi-page
    }
  }

  // --- Multi-page: pack at max dimensions per page ---
  const textures: Array<Uint8Array | Float32Array> = [];
  const regions = new Map<string, AtlasRegion>();
  let remaining = sorted;

  while (remaining.length > 0) {
    const pageIndex = textures.length;
    const packer = new MaxRectsPacker(maxW, maxH);
    const texture = createTexture(maxW, maxH, atlasFormat);
    const notPacked: AtlasEntry[] = [];

    for (const entry of remaining) {
      const rect = packer.insert(entry.width + padding, entry.height + padding);
      if (rect) {
        regions.set(entry.id, {
          x: rect.x, y: rect.y, w: entry.width, h: entry.height,
          id: entry.id, page: pageIndex,
        });
        blitEntry(entry, rect, texture, maxW, atlasFormat);
      } else {
        notPacked.push(entry);
      }
    }

    if (notPacked.length === remaining.length) {
      throw new Error(
        `Cannot pack ${remaining.length} entries into ${maxW}x${maxH} page`
      );
    }

    textures.push(texture);
    remaining = notPacked;
  }

  return {
    textures,
    atlasFormat,
    width: maxW,
    height: maxH,
    regions,
    pxRange,
  };
}

function createTexture(width: number, height: number, atlasFormat: AtlasTextureFormat): Uint8Array | Float32Array {
  const channels = getTextureChannels(atlasFormat);
  return isByteFormat(atlasFormat)
    ? new Uint8Array(width * height * channels)
    : new Float32Array(width * height * channels);
}

function blitEntry(
  entry: AtlasEntry,
  rect: Rect,
  texture: Uint8Array | Float32Array,
  atlasW: number,
  atlasFormat: AtlasTextureFormat,
): void {
  const ch = entry.channels ?? 4;
  const textureChannels = getTextureChannels(atlasFormat);
  for (let y = 0; y < entry.height; y++) {
    for (let x = 0; x < entry.width; x++) {
      const srcIdx = (y * entry.width + x) * ch;
      const dstIdx = ((rect.y + y) * atlasW + (rect.x + x)) * textureChannels;
      if (textureChannels === 1) {
        texture[dstIdx] = convertChannel(entry.bitmap[srcIdx], atlasFormat);
      } else if (ch === 1) {
        const v = convertChannel(entry.bitmap[srcIdx], atlasFormat);
        texture[dstIdx] = texture[dstIdx + 1] = texture[dstIdx + 2] = texture[dstIdx + 3] = v;
      } else if (ch === 3) {
        texture[dstIdx]     = convertChannel(entry.bitmap[srcIdx], atlasFormat);
        texture[dstIdx + 1] = convertChannel(entry.bitmap[srcIdx + 1], atlasFormat);
        texture[dstIdx + 2] = convertChannel(entry.bitmap[srcIdx + 2], atlasFormat);
        texture[dstIdx + 3] = atlasFormat === 'rgba8' ? 255 : 1;
      } else {
        texture[dstIdx]     = convertChannel(entry.bitmap[srcIdx], atlasFormat);
        texture[dstIdx + 1] = convertChannel(entry.bitmap[srcIdx + 1], atlasFormat);
        texture[dstIdx + 2] = convertChannel(entry.bitmap[srcIdx + 2], atlasFormat);
        texture[dstIdx + 3] = convertChannel(entry.bitmap[srcIdx + 3], atlasFormat);
      }
    }
  }
}

function convertChannel(floatVal: number, atlasFormat: AtlasTextureFormat): number {
  return isByteFormat(atlasFormat) ? clampByte(floatVal) : floatVal;
}

function clampByte(floatVal: number): number {
  return Math.max(0, Math.min(255, Math.round(floatVal * 255)));
}
