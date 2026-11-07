// Criação de elementos com texto sempre escapado (nunca HTML cru vindo de dados)
import { iconEl } from './icons.js';

/** h('div', { class: 'x', onclick }, 'texto', filho...) — atributos on* viram eventos */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) if (k.startsWith('--')) el.style.setProperty(k, v); else el.style[k] = v;
    }
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const ic = (name, cls) => iconEl(name, cls);

/** Aviso flutuante no rodapé da tela */
export function toast(message, kind = 'ok') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const t = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    ic(kind === 'error' ? 'circle-alert' : 'circle-check'), h('span', {}, message));
  root.append(t);
  setTimeout(() => {
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 300);
  }, kind === 'error' ? 6000 : 3800);
}

/** Avatar do barbeiro: foto (se cadastrada) ou a inicial na cor dele */
export function avatar(barber, size = 'md') {
  if (barber?.photo) {
    return h('span', { class: `avatar avatar--${size}` }, h('img', { src: `/images/barbeiros/${barber.photo}`, alt: '', loading: 'lazy', decoding: 'async' }));
  }
  return h('span', { class: `avatar avatar--${size}`, style: { '--c': barber?.color || '#c9a46a' }, 'aria-hidden': 'true' }, (barber?.name || '?').slice(0, 1).toUpperCase());
}

/** Baixa um arquivo gerado na hora (ex.: .ics do calendário) */
export function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
