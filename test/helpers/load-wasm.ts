/**
 * Load the msdf-kit WASM module in Node.js for testing.
 *
 * The production build targets web/worker only, but by passing
 * wasmBinary directly to the factory we skip all fetch/readFile
 * logic and it works in Node.js as well.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import type { MsdfKitWasmModule } from '../../typescript/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedModule: MsdfKitWasmModule | null = null;

export async function loadTestWasmModule(): Promise<MsdfKitWasmModule> {
  if (cachedModule) return cachedModule;

  const wasmPath = resolve(__dirname, '../../build/msdf-kit.wasm');
  const wasmBinary = readFileSync(wasmPath);

  const gluePath = resolve(__dirname, '../../build/msdf-kit.js');
  const glueModule = await import(pathToFileURL(gluePath).href);
  const factory = glueModule.default || glueModule;

  const module: MsdfKitWasmModule = await factory({ wasmBinary });
  module._init();

  cachedModule = module;
  return module;
}

export function loadTestFont(): ArrayBuffer {
  const fontPath = resolve(__dirname, '../fixtures/Roboto-Regular.ttf');
  const buf = readFileSync(fontPath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
