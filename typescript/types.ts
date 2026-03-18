/** SDF generation mode. */
export type SdfMode = 'sdf' | 'psdf' | 'msdf' | 'mtsdf';

/** Configuration for SDF bitmap generation. */
export interface MsdfConfig {
  /** Bitmap width in pixels. */
  width: number;
  /** Bitmap height in pixels. */
  height: number;
  /** Distance range in pixels (recommended: 4). */
  pxRange: number;
  /** Edge coloring angle threshold in radians (default: 3.0). */
  angleThreshold?: number;
  /** Edge coloring strategy (default: 'simple'). */
  coloring?: 'simple' | 'inkTrap' | 'byDistance';
  /** SDF generation mode (default: 'mtsdf'). */
  mode?: SdfMode;
}

/** Metrics for a single glyph (em-normalized). */
export interface GlyphMetrics {
  codepoint: number;
  advance: number;
  left: number;
  bottom: number;
  right: number;
  top: number;
}

/** Global font metrics (em-normalized). */
export interface FontMetrics {
  ascender: number;
  descender: number;
  lineHeight: number;
  unitsPerEm: number;
}

/** A single generated SDF bitmap entry. */
export interface AtlasEntry {
  /** Unique ID, e.g. 'glyph:65' or 'icon:arrow-right'. */
  id: string;
  /** Float data (N channels per pixel, see `channels`). */
  bitmap: Float32Array;
  /** Bitmap width in pixels. */
  width: number;
  /** Bitmap height in pixels. */
  height: number;
  /** Number of channels per pixel (1 for SDF/PSDF, 3 for MSDF, 4 for MTSDF). */
  channels: number;
  /** Glyph metrics (only for glyph entries). */
  metrics?: GlyphMetrics;
}

/** Region of a packed atlas texture. */
export interface AtlasRegion {
  /** X position in atlas (px). */
  x: number;
  /** Y position in atlas (px). */
  y: number;
  /** Width in atlas (px). */
  w: number;
  /** Height in atlas (px). */
  h: number;
  /** Reference to AtlasEntry.id. */
  id: string;
  /** Page index (0-based). */
  page: number;
}

/** Result of packing entries into a texture atlas. */
export interface PackedAtlas {
  /** All page textures (RGBA uint8). */
  textures: Uint8Array[];
  /** Page width (same for all pages). */
  width: number;
  /** Page height (same for all pages). */
  height: number;
  /** Map of id → region in the atlas. */
  regions: Map<string, AtlasRegion>;
  /** Font metrics (if atlas contains glyphs). */
  fontMetrics?: FontMetrics;
  /** The pxRange used for generation. */
  pxRange: number;
}

/** Options for atlas packing. */
export interface PackOptions {
  /** Maximum page width (default: 2048). */
  maxWidth?: number;
  /** Maximum page height (default: 2048). */
  maxHeight?: number;
  /** Padding between entries in pixels (default: 1). */
  padding?: number;
  /** Constrain dimensions to power-of-two (default: true). */
  pot?: boolean;
  /** Distance range used for generation, stored in result (default: 4). */
  pxRange?: number;
}

/** Opaque handle to a loaded font. */
export type FontHandle = number;

/** Emscripten module interface for MSDF-Kit. */
export interface MsdfKitWasmModule {
  _init(): void;
  _loadFont(dataPtr: number, length: number): number;
  _shapeFromGlyph(fontHandle: number, codepoint: number): number;
  _getGlyphMetrics(
    fontHandle: number, codepoint: number,
    advPtr: number, leftPtr: number, bottomPtr: number,
    rightPtr: number, topPtr: number
  ): void;
  _getFontMetrics(
    fontHandle: number,
    ascPtr: number, descPtr: number,
    lhPtr: number, emPtr: number
  ): void;
  _getKerning(fontHandle: number, cp1: number, cp2: number): number;
  _shapeFromSvgPath(pathDataPtr: number, viewBoxW: number, viewBoxH: number): number;
  _getShapeBounds(
    shapeHandle: number,
    leftPtr: number, bottomPtr: number,
    rightPtr: number, topPtr: number
  ): void;
  _generateMtsdf(
    shapeHandle: number, width: number, height: number,
    pxRange: number, angleThreshold: number, coloringMode: number,
    sdfMode: number
  ): number;
  _getBitmapSize(widthPtr: number, heightPtr: number): void;
  _destroyShape(handle: number): void;
  _destroyFont(handle: number): void;
  _destroyBitmap(ptr: number): void;
  _malloc(size: number): number;
  _free(ptr: number): void;

  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;

  UTF8ToString(ptr: number): string;
  stringToUTF8(str: string, outPtr: number, maxBytes: number): void;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
}
