// Keyboard shortcuts and drag-and-drop of links.

import { sfx } from '../fx/sound';
import { deal, fold, pasteAndDeal, setModal, setMode, store } from '../state/app';
import { h } from './dom';
import { extractUrl } from './format';

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

export function initKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const s = store.get();
    if (e.key === 'Escape') {
      if (s.modal) setModal(null);
      else if (document.body.classList.contains('pile-open')) document.body.classList.remove('pile-open');
      else if (s.phase !== 'idle') fold();
      return;
    }
    if (mod && e.key === ',') {
      e.preventDefault();
      setModal(s.modal === 'settings' ? null : 'settings');
      return;
    }
    if (s.modal || typing(e)) return;
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      sfx.play('paste');
      void pasteAndDeal();
      return;
    }
    if (mod || e.altKey) return;
    const hand = document.querySelector('.hand');
    if (/^[1-9]$/.test(e.key)) {
      hand?.dispatchEvent(new CustomEvent('select-index', { detail: Number(e.key) - 1 }));
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      hand?.dispatchEvent(new CustomEvent('select-step', { detail: e.key === 'ArrowRight' ? 1 : -1 }));
    } else if (e.key === 'Enter') {
      if (s.selected) (document.querySelector('[data-testid="grab"]') as HTMLElement | null)?.click();
      else if (s.url) void deal();
    } else if (e.key.toLowerCase() === 'a') setMode('audio');
    else if (e.key.toLowerCase() === 'v') setMode('video');
  });
}

export function initDragDrop(): void {
  let zone: HTMLElement | null = null;
  let depth = 0;
  const show = () => {
    if (zone) return;
    zone = h('div', { class: 'dropzone', testid: 'dropzone' }, h('b', null, 'DROP IT ON THE TABLE'));
    document.body.appendChild(zone);
    sfx.play('open');
  };
  const hide = () => {
    zone?.remove();
    zone = null;
    depth = 0;
  };
  const hasLink = (e: DragEvent) => {
    const types = e.dataTransfer?.types ?? [];
    return types.includes('text/uri-list') || types.includes('text/plain') || types.includes('text/x-moz-url');
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasLink(e)) return;
    e.preventDefault();
    depth++;
    show();
  });
  window.addEventListener('dragover', (e) => {
    if (!hasLink(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const text = dt?.getData('text/uri-list') || dt?.getData('text/plain') || '';
    hide();
    const url = extractUrl(text.split('\n').find((l) => l && !l.startsWith('#')) ?? '');
    if (url) {
      sfx.play('paste');
      void deal(url);
    } else sfx.play('error');
  });
}
