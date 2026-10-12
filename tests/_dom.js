// Minimal DOM for rendering Preact components under `node --test` (no dependencies).
// Covers exactly what preact/preact-hooks touch: node creation through ownerDocument, child list
// manipulation, attributes, style, text data and event listeners. Not a general DOM.

class Node {
  constructor(doc, nodeType) {
    this.ownerDocument = doc;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] || null;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) { return this.insertBefore(node, null); }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}

class Text extends Node {
  constructor(doc, data) { super(doc, 3); this.data = data; }
}

class Element extends Node {
  constructor(doc, name, ns = null) {
    super(doc, 1);
    this.localName = name;
    this.nodeName = name.toUpperCase();
    this.namespaceURI = ns;
    this.attributes = {};
    this.listeners = {};
    const style = {};
    Object.defineProperty(style, 'setProperty', { value: (k, v) => { style[k] = v; } });
    this.style = style;
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { if (this.listeners[type]) this.listeners[type].delete(fn); }
  dispatch(type, init = {}) {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...init };
    for (const fn of this.listeners[type] || []) fn.call(this, ev); // Preact's event proxy reads this.l
  }
}

class Document extends Node {
  constructor() { super(null, 9); this.ownerDocument = this; }
  createElement(name) { return new Element(this, name); }
  createElementNS(ns, name) { return new Element(this, name, ns); }
  createTextNode(data) { return new Text(this, data); }
}

/** A fresh container element (and its document) to render into. */
export function createContainer() {
  const doc = new Document();
  const root = doc.createElement('div');
  doc.appendChild(root);
  return root;
}

/** Wait for Preact's debounced re-render and the hooks' after-paint effects (setTimeout fallback in Node). */
export const flush = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
