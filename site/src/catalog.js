// Serviços, barbeiros e configurações da barbearia. A fonte é /api/catalog (editado no app de gestão);
// a cópia gerada no build (scripts/build-catalog.js) só é usada se a API não responder.
// Os exports são "live bindings": quem importa enxerga os dados novos após loadLiveCatalog().
import fallback from './generated/catalog.json';
import { getStoreStatus } from '../../shared/store-hours.js';

export let SERVICES = [];
export let SERVICES_BY_ID = new Map();
export let BARBERS = [];
export let BARBERS_BY_ID = new Map();
export let SETTINGS = {};
export let STORE_STATUS = { open: false, label: '' };
export let IS_LIVE = false;

let signature = '';

function apply(data, status) {
  SERVICES = data.services;
  SERVICES_BY_ID = new Map(SERVICES.map(s => [s.id, s]));
  BARBERS = data.barbers;
  BARBERS_BY_ID = new Map(BARBERS.map(b => [b.id, b]));
  SETTINGS = data.settings;
  STORE_STATUS = status || getStoreStatus(new Date(), SETTINGS);
}

apply(fallback);
signature = JSON.stringify([fallback.services, fallback.barbers, fallback.settings]);

/**
 * Busca o catálogo atual. Em caso de erro, mantém o que já está carregado.
 * Retorna { live, changed }: changed indica que serviços, barbeiros ou configurações mudaram.
 */
export async function loadLiveCatalog({ timeoutMs = 15000 } = {}) {
  try {
    const res = await fetch('/api/catalog', { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.services) || !Array.isArray(data.barbers) || !data.settings) throw new Error('resposta inválida');
    const next = JSON.stringify([data.services, data.barbers, data.settings]);
    const changed = next !== signature || Boolean(data.status?.paused) !== Boolean(STORE_STATUS.paused);
    signature = next;
    apply(data, data.status);
    IS_LIVE = true;
    return { live: true, changed };
  } catch (error) {
    console.warn('[catálogo] mantendo os dados atuais:', error.message);
    return { live: false, changed: false };
  }
}

/** Situação da barbearia agora (recalculada pelo relógio, respeitando a pausa vinda da API). */
export function currentStoreStatus() {
  if (STORE_STATUS.paused) return STORE_STATUS;
  return getStoreStatus(new Date(), { hours: SETTINGS.hours });
}
