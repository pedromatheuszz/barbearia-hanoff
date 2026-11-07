// Categorias dos serviços e o resumo (preço e duração) de uma escolha. Usado pelo site, pela API e pelo app.

export const CATEGORIES = [
  { id: 'cabelo', label: 'Cabelo' },
  { id: 'barba', label: 'Barba' },
  { id: 'combos', label: 'Combos' },
  { id: 'cuidados', label: 'Cuidados' },
  { id: 'quimica', label: 'Química' },
  { id: 'visagismo', label: 'Visagismo' },
];

export const MAX_SERVICES = 4;

export const PAYMENT_METHODS = ['pix', 'debito', 'credito', 'dinheiro'];
export const PAYMENT_LABELS = { pix: 'Pix', debito: 'Cartão de débito', credito: 'Cartão de crédito', dinheiro: 'Dinheiro' };

const round2 = (n) => Math.round(n * 100) / 100;

/** Preço do serviço com este barbeiro (alguns barbeiros têm preço próprio em certos serviços). */
export function priceFor(service, barber) {
  const own = barber?.prices?.[service.id];
  return Number.isFinite(own) ? own : Number(service.price || 0);
}

/** Soma preço e duração dos serviços escolhidos (com o preço do barbeiro, se informado). */
export function summarize(services, barber = null) {
  return {
    price: round2(services.reduce((t, s) => t + priceFor(s, barber), 0)),
    duration: services.reduce((t, s) => t + Number(s.duration || 0), 0),
    priceFrom: services.some(s => s.priceFrom),
  };
}

/** Converte ids escolhidos em serviços do catálogo, sem repetidos e na ordem do catálogo. */
export function pickServices(ids, servicesById) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string'));
  return [...servicesById.values()].filter(s => wanted.has(s.id));
}
