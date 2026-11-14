/**
 * A page for the landing-page tests: the real HTML of web/index.html or
 * web/join.html parsed into a small DOM, with a clock, timers, a network and
 * a clipboard the test drives. It implements the browser members the front
 * page and the invite page use and nothing else; a script that reaches for
 * anything more fails the test that runs it.
 *
 * The old plain scripts (tests/ts/oracles/) and the TypeScript bundles that
 * replaced them both run on it, in node:vm, so the two can be compared after
 * every step: same markup, same requests, same timers.
 */
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const REPO = new URL('../../', import.meta.url);

// ── DOM ─────────────────────────────────────────────────────────────────────

type Listener = (event: FakeEvent) => void;

/** What a listener is called with. Tests add the fields a handler reads (`key`, `clientX`, …). */
export interface FakeEvent {
  readonly type: string;
  readonly target: FakeElement | null;
  readonly [field: string]: string | number | boolean | FakeElement | null;
}

class FakeText {
  parent: FakeParent | null = null;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

type FakeChild = FakeElement | FakeText;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** One simple selector: `tag#id.class[attr="v"]:not(...):last-of-type`. */
interface Compound {
  readonly tag: string | null;
  readonly id: string | null;
  readonly classes: readonly string[];
  readonly attrs: readonly { readonly name: string; readonly value: string | null }[];
  readonly not: Compound | null;
  readonly lastOfType: boolean;
}

const parseCompound = (source: string): Compound => {
  let rest = source;
  let tag: string | null = null;
  let id: string | null = null;
  const classes: string[] = [];
  const attrs: { name: string; value: string | null }[] = [];
  let not: Compound | null = null;
  let lastOfType = false;
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const m = pattern.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  const tagMatch = take(/^[a-zA-Z][\w-]*/);
  if (tagMatch) tag = tagMatch[0].toLowerCase();
  while (rest) {
    const idMatch = take(/^#([\w-]+)/);
    const classMatch = idMatch ? null : take(/^\.([\w-]+)/);
    const attrMatch = idMatch || classMatch ? null : take(/^\[([\w-]+)(?:="([^"]*)")?\]/);
    const notMatch = idMatch || classMatch || attrMatch ? null : take(/^:not\(([^)]*)\)/);
    if (idMatch) id = idMatch[1] ?? null;
    else if (classMatch) classes.push(classMatch[1] ?? '');
    else if (attrMatch) attrs.push({ name: attrMatch[1] ?? '', value: attrMatch[2] ?? null });
    else if (notMatch) not = parseCompound(notMatch[1] ?? '');
    else if (take(/^:last-of-type/)) lastOfType = true;
    else throw new Error(`The fake page cannot read the selector "${source}"`);
  }
  return { tag, id, classes, attrs, not, lastOfType };
};

/** A selector list: alternatives, each a chain of compounds joined by descendant spaces. */
const parseSelector = (selector: string): Compound[][] =>
  selector.split(',').map((alternative) => alternative.trim().split(/\s+/).map(parseCompound));

abstract class FakeParent {
  parent: FakeParent | null = null;
  readonly childNodes: FakeChild[] = [];

  /** Nodes to insert: text for strings, a fragment's children in its place. */
  protected adopt(nodes: readonly (FakeChild | FakeFragment | string)[]): FakeChild[] {
    const out: FakeChild[] = [];
    for (const node of nodes) {
      if (typeof node === 'string') out.push(new FakeText(node));
      else if (node instanceof FakeFragment) out.push(...node.childNodes.splice(0));
      else {
        if (node instanceof FakeElement) node.remove();
        out.push(node);
      }
    }
    for (const child of out) child.parent = this;
    return out;
  }

  append(...nodes: (FakeChild | FakeFragment | string)[]): void {
    this.childNodes.push(...this.adopt(nodes));
  }

  replaceChildren(...nodes: (FakeChild | FakeFragment | string)[]): void {
    const incoming = this.adopt(nodes);
    for (const old of this.childNodes.splice(0)) if (!incoming.includes(old)) old.parent = null;
    this.childNodes.push(...incoming);
  }

  insertBefore(node: FakeElement, reference: FakeElement | null): FakeElement {
    const [incoming] = this.adopt([node]);
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    if (incoming) this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, incoming);
    return node;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((child) => child instanceof FakeElement);
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get firstChild(): FakeChild | null {
    return this.childNodes[0] ?? null;
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get parentNode(): FakeParent | null {
    return this.parent;
  }

  get textContent(): string {
    return this.childNodes.map((child) => (child instanceof FakeText ? child.text : child.textContent)).join('');
  }

  set textContent(text: string | number | null) {
    this.replaceChildren(...(text === null || text === '' ? [] : [String(text)]));
  }

  /** Every element below this one, in document order. A template's content is not below it. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const alternatives = parseSelector(selector);
    return this.descendants().filter((el) => alternatives.some((chain) => el.matchesChain(chain)));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(node: FakeChild | null): boolean {
    for (let at: FakeChild | FakeParent | null = node; at; at = at.parent) if (at === this) return true;
    return false;
  }
}

export class FakeFragment extends FakeParent {}

export class FakeElement extends FakeParent {
  readonly tagName: string;
  readonly attrs = new Map<string, string>();
  readonly style: { [property: string]: string | ((name: string, value: string) => void) };
  readonly listeners = new Map<string, Listener[]>();
  /** A `<template>`'s parsed children live here, outside the document. */
  readonly template: FakeFragment | null;
  readonly owner: FakeDocument;
  /** An input's text. */
  value = '';

  constructor(owner: FakeDocument, tagName: string) {
    super();
    this.owner = owner;
    this.tagName = tagName;
    const style: FakeElement['style'] = {};
    Object.defineProperty(style, 'setProperty', {
      enumerable: false,
      value: (name: string, value: string) => {
        style[name] = String(value);
      },
    });
    this.style = style;
    this.template = tagName === 'template' ? new FakeFragment() : null;
  }

  /** A template's content; for any other element (a `<meta>`), its `content` attribute. */
  get content(): FakeFragment | string {
    return this.template ?? this.attrs.get('content') ?? '';
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  get dataset() {
    const { attrs } = this;
    return new Proxy(
      {},
      {
        get: (_target, name) => (typeof name === 'string' ? attrs.get(`data-${kebab(name)}`) : undefined),
        set: (_target, name, value) => {
          if (typeof name === 'string') attrs.set(`data-${kebab(name)}`, String(value));
          return true;
        },
      },
    );
  }

  get classList() {
    const read = (): string[] => (this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    const write = (names: readonly string[]): void => {
      this.attrs.set('class', names.join(' '));
    };
    return {
      add: (name: string) => {
        if (!read().includes(name)) write([...read(), name]);
      },
      remove: (name: string) => {
        if (read().includes(name)) write(read().filter((n) => n !== name));
      },
      contains: (name: string) => read().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !read().includes(name);
        if (on && !read().includes(name)) write([...read(), name]);
        if (!on && read().includes(name)) write(read().filter((n) => n !== name));
        return on;
      },
    };
  }

  get isConnected(): boolean {
    return this.owner.root.contains(this);
  }

  remove(): void {
    const { parent } = this;
    if (!parent) return;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }

  matchesCompound(compound: Compound): boolean {
    if (compound.tag && compound.tag !== this.tagName) return false;
    if (compound.id && compound.id !== this.attrs.get('id')) return false;
    const classes = (this.attrs.get('class') ?? '').split(/\s+/);
    if (!compound.classes.every((name) => classes.includes(name))) return false;
    for (const attr of compound.attrs) {
      const have = this.attrs.get(attr.name);
      if (have === undefined || (attr.value !== null && attr.value !== have)) return false;
    }
    if (compound.not && this.matchesCompound(compound.not)) return false;
    if (compound.lastOfType) {
      const siblings = this.parent?.children.filter((el) => el.tagName === this.tagName) ?? [];
      if (siblings[siblings.length - 1] !== this) return false;
    }
    return true;
  }

  matchesChain(chain: readonly Compound[]): boolean {
    const last = chain[chain.length - 1];
    if (!last || !this.matchesCompound(last)) return false;
    let at = chain.length - 2;
    for (let up = this.parent; up && at >= 0; up = up.parent) {
      const compound = chain[at];
      if (compound && up instanceof FakeElement && up.matchesCompound(compound)) at--;
    }
    return at < 0;
  }

  closest(selector: string): FakeElement | null {
    const alternatives = parseSelector(selector);
    if (alternatives.some((chain) => this.matchesChain(chain))) return this;
    for (let at = this.parent; at; at = at.parent) {
      if (at instanceof FakeElement && alternatives.some((chain) => at.matchesChain(chain))) return at;
    }
    return null;
  }

  cloneNode(deep: boolean): FakeElement {
    const copy = new FakeElement(this.owner, this.tagName);
    for (const [name, value] of this.attrs) copy.attrs.set(name, value);
    if (deep) {
      copy.append(...this.childNodes.map((child) => (child instanceof FakeText ? child.text : child.cloneNode(true))));
    }
    return copy;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  /** Call this element's listeners (the fake does not bubble). `currentTarget` is this element. */
  fire(type: string, fields: { readonly [field: string]: string | number | boolean | FakeElement | null } = {}): void {
    const event: FakeEvent = { target: this, ...fields, type, currentTarget: this };
    for (const listener of (this.listeners.get(type) ?? []).slice()) listener(event);
  }

  click(): void {
    this.fire('click');
  }

  focus(): void {
    if (this.isConnected) this.owner.focused = this;
  }

  select(): void {
    this.owner.selections.push(this.value);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 32, height: 32 };
  }

  get offsetWidth(): number {
    return 0;
  }
}

// Properties that mirror an attribute, as the scripts read and write them.
for (const [property, attribute] of [
  ['id', 'id'],
  ['className', 'class'],
  ['href', 'href'],
  ['src', 'src'],
  ['alt', 'alt'],
  ['title', 'title'],
  ['type', 'type'],
  ['name', 'name'],
  ['allow', 'allow'],
  ['loading', 'loading'],
  ['decoding', 'decoding'],
  ['width', 'width'],
  ['height', 'height'],
] as const) {
  Object.defineProperty(FakeElement.prototype, property, {
    get(this: FakeElement) {
      return this.attrs.get(attribute) ?? '';
    },
    set(this: FakeElement, value: string | number) {
      this.attrs.set(attribute, String(value));
    },
  });
}
for (const [property, attribute] of [
  ['hidden', 'hidden'],
  ['disabled', 'disabled'],
  ['allowFullscreen', 'allowfullscreen'],
] as const) {
  Object.defineProperty(FakeElement.prototype, property, {
    get(this: FakeElement) {
      return this.attrs.has(attribute);
    },
    set(this: FakeElement, value: boolean) {
      if (value) this.attrs.set(attribute, '');
      else this.attrs.delete(attribute);
    },
  });
}

export class FakeDocument {
  readonly root: FakeElement;
  focused: FakeElement | null = null;
  hidden = false;
  title = '';
  /** What `execCommand('copy')` copied: the text selected at the time. */
  readonly copied: string[] = [];
  readonly selections: string[] = [];
  readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.root = new FakeElement(this, 'html');
  }

  get body(): FakeElement {
    const body = this.root.querySelector('body');
    if (!body) throw new Error('The page has no body');
    return body;
  }

  /** The focused element, or the body once it has left the page, as in a browser. */
  get activeElement(): FakeElement {
    return this.focused?.isConnected ? this.focused : this.body;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName.toLowerCase());
  }

  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }

  getElementById(id: string): FakeElement | null {
    return this.root.descendants().find((el) => el.attrs.get('id') === id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.root.querySelector(selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.root.querySelectorAll(selector);
  }

  execCommand(command: string): boolean {
    if (command === 'copy') this.copied.push(this.selections[this.selections.length - 1] ?? '');
    return true;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  fire(type: string, fields: { readonly [field: string]: string | number | boolean | FakeElement | null } = {}): void {
    const event: FakeEvent = { target: null, ...fields, type };
    for (const listener of (this.listeners.get(type) ?? []).slice()) listener(event);
  }
}

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input']);
const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['#39', "'"],
]);
const decodeEntities = (text: string): string =>
  text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES.get(name) ?? whole);

/** Parse a page of this repository's formatted HTML into `doc`. */
const parseInto = (doc: FakeDocument, html: string): void => {
  const token =
    /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^\s"'=<>/]+(?:="[^"]*")?)*)\s*(\/?)>/gi;
  const open: FakeParent[] = [doc.root];
  const top = (): FakeParent => {
    const at = open[open.length - 1];
    if (!at) throw new Error('The page closes more tags than it opens');
    return at;
  };
  let from = 0;
  for (let m = token.exec(html); m; m = token.exec(html)) {
    const text = html.slice(from, m.index);
    if (text) top().append(decodeEntities(text));
    from = token.lastIndex;
    const [, closing, opening, attributes, selfClosing] = m;
    if (closing) {
      if (open.length > 1) open.pop();
      continue;
    }
    if (!opening) continue;
    const tagName = opening.toLowerCase();
    if (tagName === 'html') {
      for (const a of (attributes ?? '').matchAll(/([^\s"'=<>/]+)(?:="([^"]*)")?/g)) {
        doc.root.attrs.set(a[1] ?? '', decodeEntities(a[2] ?? ''));
      }
      continue;
    }
    const el = new FakeElement(doc, tagName);
    for (const a of (attributes ?? '').matchAll(/([^\s"'=<>/]+)(?:="([^"]*)")?/g)) {
      el.attrs.set(a[1] ?? '', decodeEntities(a[2] ?? ''));
    }
    top().append(el);
    if (tagName === 'script' || tagName === 'style') {
      const end = html.indexOf(`</${tagName}>`, from);
      from = token.lastIndex = end + tagName.length + 3;
    } else if (!selfClosing && !VOID_TAGS.has(tagName)) {
      open.push(el.template ?? el);
    }
  }
};

/** The markup of a node and everything below it, attributes in name order, with what the scripts set as properties. */
export const markup = (node: FakeChild | FakeFragment): string => {
  if (node instanceof FakeText) return node.text;
  const inner = node.childNodes.map(markup).join('');
  if (node instanceof FakeFragment) return inner;
  const attrs = [...node.attrs].map(([name, value]) => ` ${name}="${value}"`);
  if (node.value) attrs.push(` .value="${node.value}"`);
  const style = Object.entries(node.style)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}:${String(value)}`)
    .sort()
    .join(';');
  if (style) attrs.push(` .style="${style}"`);
  const content = node.template ? markup(node.template) : '';
  return `<${node.tagName}${attrs.sort().join('')}>${content}${inner}</${node.tagName}>`;
};

// ── Clock, timers, network ──────────────────────────────────────────────────

/** A parsed JSON body. */
export type JsonBody = string | number | boolean | null | readonly JsonBody[] | { readonly [field: string]: JsonBody };

/** How the fake server answers one request. */
export type Reply =
  /** A response with this status and JSON body. */
  | { readonly status: number; readonly json: JsonBody }
  /** A response with this status whose body is not JSON. */
  | { readonly status: number; readonly text: string }
  /** The request fails: no network, or nothing listening. */
  | 'fail'
  /** No answer yet: the request stays out until the test releases it or the page gives up on it. */
  | 'hold';

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<JsonBody>;
}

interface Held {
  readonly url: string;
  readonly settle: (reply: Reply) => void;
}

interface Timer {
  readonly id: number;
  at: number;
  readonly every: number | null;
  readonly run: () => void;
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export interface PageOptions {
  /** `index.html` or `join.html`, from web/. */
  readonly file: 'index.html' | 'join.html';
  /** The page's address. */
  readonly url: string;
  readonly userAgent?: string;
  /** The browser has WebRTC. Default true. */
  readonly webrtc?: boolean;
  /** The browser has WebAssembly. Default true. */
  readonly wasm?: boolean;
  /** `navigator.clipboard.writeText` works. Default true. */
  readonly clipboard?: boolean;
  /** `prefers-reduced-motion: reduce`. Default false. */
  readonly reducedMotion?: boolean;
  /** What localStorage holds, by key. */
  readonly stored?: ReadonlyMap<string, string>;
  /** The storage wrapper throws, as when the small site bundle did not load. Default false. */
  readonly storageBroken?: boolean;
  /** Replace text in the page's HTML before it is parsed: `[from, to]`. */
  readonly edit?: readonly [string, string];
}

export class FakePage {
  readonly document = new FakeDocument();
  /** Milliseconds since the epoch, moved only by `advance`. */
  now = 1_800_000_000_000;
  /** Every request the page made, oldest first: method, address and (for a POST) body. */
  readonly requests: string[] = [];
  /** Requests waiting for an answer. */
  readonly held: Held[] = [];
  /** Where the page sent the browser. */
  readonly navigations: string[] = [];
  /** What the page put on the clipboard through the clipboard API. */
  readonly clipboard: string[] = [];
  readonly stored: Map<string, string>;
  /** Decides each request's answer. Tests replace it. */
  server: (url: string) => Reply = () => 'fail';

  /** The page's `window`: what the scripts are run on. */
  readonly window: vm.Context;
  private readonly timers: Timer[] = [];
  private timerIds = 0;
  private randomCalls = 0;
  private readonly windowListeners = new Map<string, Listener[]>();

  constructor(options: PageOptions) {
    const source = readFileSync(new URL(`web/${options.file}`, REPO), 'utf8');
    parseInto(this.document, options.edit ? source.replace(options.edit[0], options.edit[1]) : source);
    this.stored = new Map(options.stored);
    const address = new URL(options.url);
    const { navigations } = this;

    const setTimer = (run: () => void, ms: number, every: number | null): number => {
      const id = ++this.timerIds;
      this.timers.push({ id, at: this.now + ms, every, run });
      return id;
    };
    const clearTimer = (id: number): void => {
      const at = this.timers.findIndex((timer) => timer.id === id);
      if (at >= 0) this.timers.splice(at, 1);
    };

    const fetch = (input: string | URL, init: RequestInit = {}): Promise<FakeResponse> => {
      const url = String(input);
      const method = init.method ?? 'GET';
      this.requests.push(typeof init.body === 'string' ? `${method} ${url} ${init.body}` : `${method} ${url}`);
      return new Promise((resolve, reject) => {
        const settle = (reply: Reply): void => {
          if (reply === 'hold') {
            const held: Held = { url, settle };
            this.held.push(held);
            init.signal?.addEventListener('abort', () => {
              const at = this.held.indexOf(held);
              if (at < 0) return;
              this.held.splice(at, 1);
              reject(new Error('The request was given up'));
            });
            return;
          }
          if (reply === 'fail') {
            reject(new TypeError('Failed to fetch'));
            return;
          }
          resolve({
            ok: reply.status >= 200 && reply.status < 300,
            status: reply.status,
            json: async () => {
              if ('text' in reply) throw new SyntaxError(`Unexpected token in ${reply.text}`);
              return reply.json;
            },
          });
        };
        settle(this.server(url));
      });
    };

    const math = Object.create(Math, {
      // A fixed sequence, so a page that draws a random visitor id draws the same one each run.
      random: { value: () => ((++this.randomCalls * 7919) % 10007) / 10007 },
    });

    this.window = {
      document: this.document,
      location: {
        get href() {
          return address.href;
        },
        set href(next: string) {
          navigations.push(next);
        },
        search: address.search,
        origin: address.origin,
      },
      navigator: {
        userAgent: options.userAgent ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36',
        clipboard:
          options.clipboard === false
            ? undefined
            : {
                writeText: async (text: string) => {
                  this.clipboard.push(text);
                },
              },
      },
      crypto: {
        // Counting bytes: the same room code each run.
        getRandomValues: (bytes: Uint8Array) => {
          bytes.forEach((_, index) => {
            bytes[index] = index * 37 + 5;
          });
          return bytes;
        },
      },
      Date: { now: () => this.now },
      Math: math,
      fetch,
      setTimeout: (run: () => void, ms: number) => setTimer(run, ms, null),
      setInterval: (run: () => void, ms: number) => setTimer(run, ms, ms),
      clearTimeout: clearTimer,
      clearInterval: clearTimer,
      matchMedia: () => ({ matches: options.reducedMotion ?? false }),
      addEventListener: (type: string, listener: Listener) => {
        this.windowListeners.set(type, [...(this.windowListeners.get(type) ?? []), listener]);
      },
      KNStorage: {
        get: (_store: string, key: string) => {
          if (options.storageBroken) throw new Error('storage is blocked');
          return this.stored.get(key) ?? null;
        },
        set: (_store: string, key: string, value: string) => {
          if (options.storageBroken) throw new Error('storage is blocked');
          this.stored.set(key, value);
        },
      },
    };
    if (options.webrtc !== false) this.window.RTCPeerConnection = function RTCPeerConnection() {};
    if (options.wasm !== false) this.window.WebAssembly = {};
  }

  /** The element with this id. */
  el(id: string): FakeElement {
    const found = this.document.getElementById(id);
    if (!found) throw new Error(`The page has no #${id}`);
    return found;
  }

  /** Call the listeners the page put on `window`. */
  fireWindow(
    type: string,
    fields: { readonly [field: string]: string | number | boolean | FakeElement | null } = {},
  ): void {
    const event: FakeEvent = { target: null, ...fields, type };
    for (const listener of (this.windowListeners.get(type) ?? []).slice()) listener(event);
  }

  /** Let every promise the page is waiting on run. */
  async settle(): Promise<void> {
    await settled();
    await settled();
  }

  /** Answer the oldest request still out whose address contains `part`. */
  async release(part: string, reply: Reply): Promise<void> {
    const at = this.held.findIndex((held) => held.url.includes(part));
    const [held] = at < 0 ? [] : this.held.splice(at, 1);
    if (!held) throw new Error(`No request to ${part} is waiting`);
    held.settle(reply);
    await this.settle();
  }

  /** Move the clock on by `ms`, running each timer as it comes due and letting the page settle after each. */
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.now = due.at;
      if (due.every === null) this.timers.splice(this.timers.indexOf(due), 1);
      else due.at += due.every;
      due.run();
      await this.settle();
    }
    this.now = until;
    await this.settle();
  }

  /**
   * Everything a visitor or the server could tell apart: the page's markup,
   * title and focus, where it sent the browser, what it asked the server,
   * what it copied and stored, and when its timers are due.
   */
  snapshot(): string {
    const focus = this.document.activeElement;
    return [
      `title: ${this.document.title}`,
      `focus: ${focus.tagName}#${focus.attrs.get('id') ?? ''}[${focus.attrs.get('data-act') ?? ''}] in ${
        focus.closest('.room, #featured')?.attrs.get('data-code') ?? ''
      }`,
      `navigations: ${this.navigations.join(' ')}`,
      `requests:\n  ${this.requests.join('\n  ')}`,
      `waiting: ${this.held.map((held) => held.url).join(' ')}`,
      `clipboard: ${[...this.clipboard, ...this.document.copied].join(' ')}`,
      `stored: ${[...this.stored].map(([key, value]) => `${key}=${value}`).join(' ')}`,
      `timers due in: ${this.timers
        .map((timer) => `${timer.at - this.now}${timer.every === null ? '' : ' (repeating)'}`)
        .sort()
        .join(', ')}`,
      markup(this.document.root),
    ].join('\n');
  }
}

// ── Running the scripts ─────────────────────────────────────────────────────

/** Browser globals that hold no page state; both scripts get the real ones. */
const PLATFORM = { URL, URLSearchParams, AbortController };

/**
 * Run a plain script from tests/ts/oracles/ on `page`, the way a browser ran
 * it: the page's members are its globals.
 */
export const runOldScript = (name: 'join.js' | 'landing.js', page: FakePage): void => {
  const source = readFileSync(new URL(`tests/ts/oracles/${name}`, REPO), 'utf8');
  vm.runInNewContext(source, { ...PLATFORM, ...page.window, window: page.window }, { filename: name });
};

const bundles = new Map<string, string>();

/**
 * Bundle an entry from web/src as scripts/build-web.mjs does (unminified, so
 * a failure names its line) and run it on `page`. The bundle gets `window`
 * and nothing else of the page: a module that reaches past the page it was
 * handed (a bare `document`, `fetch` or `setTimeout`) fails here.
 */
export const runBundle = (entry: 'join-entry.ts' | 'landing-entry.ts', page: FakePage): void => {
  let source = bundles.get(entry);
  if (source === undefined) {
    const built = buildSync({
      absWorkingDir: new URL('.', REPO).pathname,
      entryPoints: [`web/src/${entry}`],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      logLevel: 'silent',
    });
    source = built.outputFiles[0]?.text ?? '';
    bundles.set(entry, source);
  }
  vm.runInNewContext(source, { ...PLATFORM, window: page.window }, { filename: entry });
};

/** The source files a bundle is made of, as paths from the repository root. */
export const bundleInputs = (entry: 'join-entry.ts' | 'landing-entry.ts'): string[] =>
  Object.keys(
    buildSync({
      absWorkingDir: new URL('.', REPO).pathname,
      entryPoints: [`web/src/${entry}`],
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
    }).metafile.inputs,
  );
