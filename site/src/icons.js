// Ícones do site: traço único, na cor da marca, iguais em qualquer aparelho.
// Base: Lucide (licença ISC, pacote lucide-static). Navalha, WhatsApp e Instagram foram
// desenhados aqui porque o Lucide não tem (as marcas saíram do pacote).
// O sprite com os <symbol> é montado no build pelo plugin iconSprite (site/vite.config.js) e
// entra no começo do <body>; o HTML e o JS só referenciam: <svg><use href="#i-nome"></use></svg>.

export const LUCIDE_ICONS = [
  // interface
  'moon', 'sun', 'menu', 'x', 'check', 'circle-check', 'chevron-left', 'chevron-right', 'arrow-right', 'arrow-left',
  'circle-alert', 'triangle-alert', 'info', 'external-link', 'copy', 'sparkles', 'star', 'quote',
  // agenda
  'calendar', 'calendar-check', 'calendar-plus', 'calendar-x', 'clock', 'hourglass', 'user-round', 'users', 'user-check',
  // serviços
  'scissors', 'layers', 'droplets', 'flask-conical', 'scan-face', 'crown',
  // barbearia, pagamento e contato
  'map-pin', 'navigation', 'phone', 'message-circle', 'wifi', 'car', 'accessibility', 'heart-handshake',
  'qr-code', 'credit-card', 'banknote', 'store',
];

export const CUSTOM_ICONS = {
  // navalha aberta: lâmina e cabo
  razor: '<path d="M3 15.5 13.5 5a2.1 2.1 0 0 1 3 0l.5.5-11 11.5H4a1 1 0 0 1-1-1z"/>'
    + '<path d="m13 11 2.5 2.5"/><path d="M15.5 13.5 21 19a1.4 1.4 0 0 1-2 2l-5.5-5.5"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".5" fill="currentColor"/>',
  whatsapp: '<path fill="currentColor" stroke="none" d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.39-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/>'
    + '<path fill="none" d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.9 5-1.3A9.8 9.8 0 1 0 12 2.2z"/>',
};

/** Ícone de cada categoria de serviço */
export const CATEGORY_ICONS = {
  cabelo: 'scissors', barba: 'razor', combos: 'layers', cuidados: 'droplets', quimica: 'flask-conical', visagismo: 'scan-face',
};

/** Marcação de um ícone para usar em templates (texto HTML). */
export const icon = (name, cls = '') =>
  `<svg class="icon${cls ? ` ${cls}` : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

/** O mesmo ícone como elemento, para montar a tela com DOM em vez de innerHTML. */
export function iconEl(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
