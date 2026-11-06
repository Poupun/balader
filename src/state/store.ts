// A minimal observable store: immutable snapshots, shallow-merge updates,
// listeners get (next, prev) so widgets re-render only what changed.

export type Listener<S> = (next: S, prev: S) => void;

export interface Store<S> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const delta = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const k of Object.keys(delta) as (keyof S)[]) {
        if (!Object.is(delta[k], prev[k])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...prev, ...delta };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Did any of these keys change between two snapshots? */
export function changed<S>(next: S, prev: S, ...keys: (keyof S)[]): boolean {
  return keys.some((k) => !Object.is(next[k], prev[k]));
}
