import type { MsdfKitWasmModule } from './types.js';

export function getBundledWasmUrl(): string {
  return new URL('../build/msdf-kit.wasm', import.meta.url).href;
}

export function getBundledGlueUrl(): string {
  return new URL('../build/msdf-kit.js', import.meta.url).href;
}

/**
 * Load and initialize the MSDF-Kit WASM module.
 * @param wasmUrl URL to the msdf-kit.wasm file
 * @returns Initialized Emscripten module
 */
export async function loadWasmModule(
  wasmUrl: string,
  glueUrl: string = wasmUrl.replace(/\.wasm(?:\?.*)?$/, '.js')
): Promise<MsdfKitWasmModule> {
  // The Emscripten glue JS file exports a factory function named MsdfKitModule.
  // We need to dynamically import or fetch it.
  // By default, the glue file is expected to live next to the .wasm file.

  // Dynamic import of the Emscripten glue module
  const glueModule = await import(/* @vite-ignore */ glueUrl);
  const factory = glueModule.default || glueModule;

  const module: MsdfKitWasmModule = await factory({
    locateFile(path: string) {
      if (path.endsWith('.wasm')) {
        return wasmUrl;
      }
      return path;
    },
  });

  // Initialize FreeType
  module._init();

  return module;
}
