// Animações (GSAP): entrada da abertura e revelação das seções ao rolar.
// Respeitam "reduzir movimento" do sistema: nesse caso nada se mexe.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let enabled = false;

export function initAnimations() {
  if (!window.matchMedia('(prefers-reduced-motion: no-preference)').matches) return;
  gsap.registerPlugin(ScrollTrigger);
  enabled = true;

  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.from('[data-anim="hero"]', { y: 26, opacity: 0, duration: 0.8, stagger: 0.08 })
    .from('[data-anim="ticket"]', { y: 36, rotate: 1.5, opacity: 0, duration: 0.9 }, 0.25)
    .from('.pole', { scaleY: 0.4, opacity: 0, duration: 0.9, transformOrigin: '50% 0%' }, 0.4);

  // revela os blocos marcados com data-reveal (inclusive os criados depois pelo catálogo)
  const reveal = (el) => {
    if (el.dataset.revealed) return;
    el.dataset.revealed = '1';
    gsap.from(el, { y: 28, opacity: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
  };
  document.querySelectorAll('[data-reveal]').forEach(reveal);
  new MutationObserver(() => {
    document.querySelectorAll('[data-reveal]:not([data-revealed])').forEach(reveal);
    refreshAnimations();
  }).observe(document.getElementById('barbeiros'), { childList: true, subtree: true });
  // as fontes chegam depois do primeiro desenho e mudam a altura da página: recalcula os pontos de disparo
  document.fonts?.ready.then(refreshAnimations);
  window.addEventListener('load', refreshAnimations);
}

let pending = null;
/** Recalcula as posições das animações de rolagem (depois de mudar o conteúdo da página). */
export function refreshAnimations() {
  if (!enabled) return;
  clearTimeout(pending);
  pending = setTimeout(() => ScrollTrigger.refresh(), 120);
}
