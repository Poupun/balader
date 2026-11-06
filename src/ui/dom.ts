// Tiny hyperscript. No framework: the UI is a handful of hand-tuned widgets
// whose animations need direct control over their elements.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyProps(el: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'style' && typeof value === 'object') {
      const style = (el as HTMLElement).style;
      for (const [k, v] of Object.entries(value as Record<string, string>)) {
        if (k.startsWith('--')) style.setProperty(k, String(v));
        else (style as unknown as Record<string, string>)[k] = v;
      }
    }
    else if (key === 'testid') el.setAttribute('data-testid', String(value));
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === 'value' || key === 'checked' || key === 'disabled') (el as unknown as Record<string, unknown>)[key] = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (props) applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  for (const c of children) append(el, c);
}

export function rect(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

/** Restart a CSS animation class on an element. */
export function retrigger(el: Element, cls: string): void {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}
