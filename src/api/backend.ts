// The UI talks to exactly one Backend. Three implementations:
//   tauri – the real desktop app (IPC)
//   http  – the real core over HTTP+SSE (`balader serve`), in any browser
//   mock  – deterministic simulator for development and tests
// Pick with ?backend=mock|http (default: tauri when inside the app, else mock).

import type { CoreEvent } from './types';

export type BackendKind = 'tauri' | 'http' | 'mock';
export type WindowAction = 'minimize' | 'maximize' | 'close';

export interface Backend {
  readonly kind: BackendKind;
  /** The core dispatcher: same command names and JSON as `balader call`. */
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  onEvent(cb: (e: CoreEvent) => void): () => void;
  pickFolder(start?: string): Promise<string | null>;
  readClipboard(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  windowAction(action: WindowAction): Promise<void>;
}

export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function selectBackend(params: URLSearchParams): Promise<Backend> {
  const wanted = params.get('backend');
  if ((wanted === null || wanted === 'tauri') && inTauri()) {
    const { TauriBackend } = await import('./tauri');
    return new TauriBackend();
  }
  if (wanted === 'http') {
    const { HttpBackend } = await import('./http');
    return new HttpBackend(params.get('api') ?? 'http://127.0.0.1:4317', params.get('token') ?? 'devtoken');
  }
  const { MockBackend } = await import('./mock');
  return new MockBackend({
    engine: params.get('engine') === 'missing' ? 'missing' : 'ready',
    seed: Number(params.get('seed') ?? 7),
    latency: params.has('latency') ? Number(params.get('latency')) : undefined,
    history: params.get('history') !== 'empty',
  });
}
