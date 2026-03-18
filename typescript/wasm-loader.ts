import type { MsdfKitWasmModule } from './types.js';

export function getBundledWasmUrl(): string {
  return new URL('../build/msdf-kit.wasm', import.meta.url).href;
}

export function getBundledGlueUrl(): string {
  return new URL('../build/msdf-kit.js', import.meta.url).href;
}

async function loadGlueFactory(glueUrl: string): Promise<(options?: object) => Promise<MsdfKitWasmModule>> {
  const glueModule = await import(/* @vite-ignore */ glueUrl);
  const importedFactory = getFactoryFromModule(glueModule);
  if (importedFactory) return importedFactory;

  // Emscripten glue may be emitted as a plain script without ESM exports.
  // Wrap it into a temporary module that re-exports the factory by name.
  const response = await fetch(glueUrl);
  if (!response.ok) {
    throw new Error(`Failed to load WASM glue module: ${response.status} ${response.url}`);
  }

  const source = await response.text();
  const wrappedSource = `${source}\nexport default MsdfKitModule;\n`;
  const blobUrl = URL.createObjectURL(new Blob([wrappedSource], { type: 'text/javascript' }));

  try {
    const wrappedModule = await import(/* @vite-ignore */ blobUrl);
    const wrappedFactory = getFactoryFromModule(wrappedModule);
    if (!wrappedFactory) {
      throw new TypeError(`WASM glue module did not export a callable factory: ${glueUrl}`);
    }
    return wrappedFactory;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function getFactoryFromModule(
  glueModule: unknown
): ((options?: object) => Promise<MsdfKitWasmModule>) | null {
  if (typeof glueModule === 'function') return glueModule as (options?: object) => Promise<MsdfKitWasmModule>;
  if (!glueModule || typeof glueModule !== 'object') return null;

  const candidates = glueModule as Record<string, unknown>;
  const factory = candidates.default ?? candidates.MsdfKitModule;
  return typeof factory === 'function'
    ? (factory as (options?: object) => Promise<MsdfKitWasmModule>)
    : null;
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
  const factory = await loadGlueFactory(glueUrl);

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
