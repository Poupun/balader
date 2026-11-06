import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { Backend, WindowAction } from './backend';
import type { CoreEvent } from './types';
import { toError } from './types';

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;

  async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await invoke<T>('core', { cmd, args });
    } catch (e) {
      throw toError(e);
    }
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    let un: (() => void) | null = null;
    let dead = false;
    void listen<CoreEvent>('balader://event', (ev) => cb(ev.payload)).then((f) => {
      if (dead) f();
      else un = f;
    });
    return () => {
      dead = true;
      un?.();
    };
  }

  async pickFolder(start?: string): Promise<string | null> {
    return invoke<string | null>('pick_folder', { start: start ?? null });
  }

  async readClipboard(): Promise<string | null> {
    return invoke<string | null>('read_clipboard');
  }

  async openPath(path: string): Promise<void> {
    await invoke('open_path', { path }).catch((e) => {
      throw toError(e);
    });
  }

  async revealPath(path: string): Promise<void> {
    await invoke('reveal_path', { path }).catch((e) => {
      throw toError(e);
    });
  }

  async windowAction(action: WindowAction): Promise<void> {
    await invoke('window_action', { action });
  }
}
