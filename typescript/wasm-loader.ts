import type { MsdfKitWasmModule } from './types.js';

/**
 * Load and initialize the MSDF-Kit WASM module.
 * @param wasmUrl URL to the msdf-kit.wasm file
 * @returns Initialized Emscripten module
 */
export async function loadWasmModule(wasmUrl: string): Promise<MsdfKitWasmModule> {
  // The Emscripten glue JS file exports a factory function named MsdfKitModule.
  // We need to dynamically import or fetch it.
  // The glue file is expected to be at the same base path as the .wasm file.
  const glueUrl = wasmUrl.replace(/\.wasm$/, '.js');

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
