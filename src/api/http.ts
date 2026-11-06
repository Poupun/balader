// Real engine, plain browser: talks to `balader serve` (see crates/balader-cli/src/serve.rs).

import type { Backend, WindowAction } from './backend';
import type { CoreEvent } from './types';
import { toError } from './types';

export class HttpBackend implements Backend {
  readonly kind = 'http' as const;

  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/invoke/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-balader-token': this.token },
        body: JSON.stringify(args),
      });
    } catch (e) {
      throw { code: 'network', message: 'The test server is not answering.', hint: 'Start it with `npm run serve:real`.', detail: String(e) };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw toError(body);
    return body as T;
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    const es = new EventSource(`${this.base}/api/events?token=${encodeURIComponent(this.token)}`);
    es.onmessage = (m) => {
      try {
        cb(JSON.parse(m.data) as CoreEvent);
      } catch {
        /* keep-alive or garbage */
      }
    };
    return () => es.close();
  }

  async pickFolder(start?: string): Promise<string | null> {
    return window.prompt('Folder path (test server mode)', start ?? '') || null;
  }

  async readClipboard(): Promise<string | null> {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }

  async openPath(path: string): Promise<void> {
    await this.call('open_path', { path });
  }

  async revealPath(path: string): Promise<void> {
    await this.call('reveal_path', { path });
  }

  async windowAction(_action: WindowAction): Promise<void> {}
}
