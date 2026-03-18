import type { AtlasEntry, AtlasRegion, PackedAtlas, PackOptions } from './types.js';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
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
      const texture = new Uint8Array(atlasW * atlasH * 4);
      for (const { entry, rect } of placements) {
        regions.set(entry.id, {
          x: rect.x, y: rect.y, w: entry.width, h: entry.height,
          id: entry.id, page: 0,
        });
        blitEntry(entry, rect, texture, atlasW);
      }
      return { textures: [texture], width: atlasW, height: atlasH, regions, pxRange };
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
  const textures: Uint8Array[] = [];
  const regions = new Map<string, AtlasRegion>();
  let remaining = sorted;

  while (remaining.length > 0) {
    const pageIndex = textures.length;
    const packer = new MaxRectsPacker(maxW, maxH);
    const texture = new Uint8Array(maxW * maxH * 4);
    const notPacked: AtlasEntry[] = [];

    for (const entry of remaining) {
      const rect = packer.insert(entry.width + padding, entry.height + padding);
      if (rect) {
        regions.set(entry.id, {
          x: rect.x, y: rect.y, w: entry.width, h: entry.height,
          id: entry.id, page: pageIndex,
        });
        blitEntry(entry, rect, texture, maxW);
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
    width: maxW,
    height: maxH,
    regions,
    pxRange,
  };
}

function blitEntry(entry: AtlasEntry, rect: Rect, texture: Uint8Array, atlasW: number): void {
  const ch = entry.channels ?? 4;
  for (let y = 0; y < entry.height; y++) {
    for (let x = 0; x < entry.width; x++) {
      const srcIdx = (y * entry.width + x) * ch;
      const dstIdx = ((rect.y + y) * atlasW + (rect.x + x)) * 4;
      if (ch === 1) {
        const v = clampByte(entry.bitmap[srcIdx]);
        texture[dstIdx] = texture[dstIdx + 1] = texture[dstIdx + 2] = texture[dstIdx + 3] = v;
      } else if (ch === 3) {
        texture[dstIdx]     = clampByte(entry.bitmap[srcIdx]);
        texture[dstIdx + 1] = clampByte(entry.bitmap[srcIdx + 1]);
        texture[dstIdx + 2] = clampByte(entry.bitmap[srcIdx + 2]);
        texture[dstIdx + 3] = 255;
      } else {
        texture[dstIdx]     = clampByte(entry.bitmap[srcIdx]);
        texture[dstIdx + 1] = clampByte(entry.bitmap[srcIdx + 1]);
        texture[dstIdx + 2] = clampByte(entry.bitmap[srcIdx + 2]);
        texture[dstIdx + 3] = clampByte(entry.bitmap[srcIdx + 3]);
      }
    }
  }
}

function clampByte(floatVal: number): number {
  return Math.max(0, Math.min(255, Math.round(floatVal * 255)));
}
