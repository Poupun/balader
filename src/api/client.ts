// Typed wrappers over the core dispatcher. Command names and argument shapes
// are the contract shared with the Rust side (crates/balader-core/src/core.rs).

import type { Backend, WindowAction } from './backend';
import type { AppInfo, DownloadRequest, EngineStatus, HistoryEntry, JobSnapshot, ProbeResult, Settings, SniffCandidate } from './types';

let backend: Backend | null = null;

export function setBackend(b: Backend): void {
  backend = b;
}

export function getBackend(): Backend {
  if (!backend) throw new Error('backend not ready');
  return backend;
}

const call = <T>(cmd: string, args?: Record<string, unknown>) => getBackend().call<T>(cmd, args);

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  engineStatus: (refresh = false) => call<EngineStatus>('engine_status', { refresh }),
  engineInstall: (components: string[] = [], force = false) => call<EngineStatus>('engine_install', { components, force }),
  engineCheckUpdates: () => call<EngineStatus>('engine_check_updates'),
  probe: (url: string) => call<ProbeResult>('probe', { url }),
  sniff: (url: string) => call<SniffCandidate[]>('sniff', { url }),
  startDownload: (request: DownloadRequest) => call<JobSnapshot>('start_download', { request }),
  listJobs: () => call<JobSnapshot[]>('list_jobs'),
  cancelJob: (id: string) => call<JobSnapshot>('cancel_job', { id }),
  retryJob: (id: string) => call<JobSnapshot>('retry_job', { id }),
  removeJob: (id: string) => call<boolean>('remove_job', { id }),
  clearFinished: () => call<string[]>('clear_finished'),
  getSettings: () => call<Settings>('get_settings'),
  saveSettings: (settings: Settings) => call<Settings>('save_settings', { settings }),
  getHistory: () => call<HistoryEntry[]>('get_history'),
  removeHistory: (id: string) => call<boolean>('remove_history', { id }),
  clearHistory: () => call<boolean>('clear_history'),
  thumbnail: (url: string, referer?: string | null) => call<string>('thumbnail', { url, referer: referer ?? null }),
  pickFolder: (start?: string) => getBackend().pickFolder(start),
  readClipboard: () => getBackend().readClipboard(),
  openPath: (path: string) => getBackend().openPath(path),
  revealPath: (path: string) => getBackend().revealPath(path),
  windowAction: (a: WindowAction) => getBackend().windowAction(a),
};
