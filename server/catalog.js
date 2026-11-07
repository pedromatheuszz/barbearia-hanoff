// Serviços, barbeiros e configurações da barbearia guardados no banco (editados pelo app de gestão).
import fs from 'fs';
import path from 'path';
import { HttpError } from './http.js';
import { CATEGORIES } from '../shared/services.js';
import { DEFAULT_HOURS, normalizeHours, getStoreStatus } from '../shared/store-hours.js';
import { normalizeSchedule, SLOT_INTERVALS, GRANULE } from '../shared/schedule.js';

const num = (v) => Math.round(Number(v ?? 0) * 100) / 100;
const PHOTO_RE = /^[\w-]+\.(png|jpe?g|webp|avif)$/i;
const ID_RE = /^[a-z0-9_]{2,40}$/;
const CATEGORY_IDS = CATEGORIES.map(c => c.id);

// Valores padrão de cada configuração da barbearia
export const STORE_DEFAULTS = {
  storeName: 'Barbearia Hanoff',
  whatsappPhone: '',
  address: '',
  city: '',
  instagram: '',
  mapsUrl: '',
  hours: DEFAULT_HOURS,
  slotInterval: 15,       // de quanto em quanto tempo o site oferece horários
  minNoticeMinutes: 30,   // antecedência mínima para agendar pelo site
  maxDaysAhead: 30,       // até quantos dias à frente o site aceita agendamentos
  cancelHours: 2,         // o cliente cancela pelo link até X horas antes
  paused: false,
  pauseMessage: '',
};

// Campos que o site pode ver (o resto fica só no app)
const PUBLIC_SETTINGS = ['storeName', 'whatsappPhone', 'address', 'city', 'instagram', 'mapsUrl', 'hours', 'slotInterval', 'minNoticeMinutes', 'maxDaysAhead', 'cancelHours'];

// ---------- Leitura ----------

const toService = (r) => ({
  id: r.id,
  name: r.name,
  category: r.category,
  price: num(r.price),
  priceFrom: r.price_from,
  duration: r.duration_min,
  desc: r.description,
  badge: r.badge,
  active: r.active,
  order: r.sort_order,
});

const toBarber = (r) => ({
  id: r.id,
  name: r.name,
  title: r.title,
  bio: r.bio,
  photo: r.photo,
  color: r.color,
  schedule: r.schedule ?? null,
  skipServices: r.skip_services || [],
  prices: Object.fromEntries(Object.entries(r.prices || {}).map(([k, v]) => [k, num(v)])),
  commissionPercent: num(r.commission_percent),
  active: r.active,
  order: r.sort_order,
});

export async function getStoreSettings(db) {
  const rows = await db.query('SELECT key, value FROM store_settings');
  const settings = { ...STORE_DEFAULTS };
  for (const { key, value } of rows) if (key in STORE_DEFAULTS) settings[key] = value;
  return settings;
}

/** Catálogo completo (inclusive inativos) — usado pelo app de gestão. */
export async function getFullCatalog(db) {
  const [services, barbers, settings] = await Promise.all([
    db.query('SELECT * FROM services ORDER BY sort_order, name'),
    db.query('SELECT * FROM barbers ORDER BY sort_order, name'),
    getStoreSettings(db),
  ]);
  return { services: services.map(toService), barbers: barbers.map(toBarber), settings };
}

/** Dados usados para calcular horários e validar agendamentos no servidor (só itens ativos). */
export async function getBookingCatalog(db) {
  const full = await getFullCatalog(db);
  const services = full.services.filter(s => s.active);
  return {
    servicesById: new Map(services.map(s => [s.id, s])),
    allServicesById: new Map(full.services.map(s => [s.id, s])),
    barbers: full.barbers.filter(b => b.active),
    allBarbers: full.barbers,
    settings: full.settings,
  };
}

/** Visão pública para o site (sem itens inativos nem comissões). */
export async function getPublicCatalog(db, now = new Date()) {
  const full = await getFullCatalog(db);
  const s = full.settings;
  return {
    services: full.services.filter(x => x.active).map(({ active, ...x }) => x),
    barbers: full.barbers.filter(b => b.active).map(({ id, name, title, bio, photo, color, schedule, skipServices, prices, order }) => ({ id, name, title, bio, photo, color, schedule, skipServices, prices, order })),
    settings: Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k]])),
    status: getStoreStatus(now, s),
  };
}

// ---------- Validação das edições ----------

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function money(v, label) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(422, `${label} inválido`);
  return Math.round(n * 100) / 100;
}
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
// ordem de exibição: inteiro numa faixa que cabe na coluna INT do banco
const int = (v, fallback) => (Number.isInteger(Number(v)) && v !== '' && v !== null && Math.abs(Number(v)) <= 1000000 ? Number(v) : fallback);

function intIn(v, min, max, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, `${label}: use um número de ${min} a ${max}`);
  return n;
}

export function validateService(input, existing = null) {
  const b = input || {};
  const s = {
    id: existing ? existing.id : str(b.id, 40).toLowerCase(),
    name: b.name !== undefined ? str(b.name, 80) : existing?.name,
    category: b.category !== undefined ? b.category : existing?.category,
    price: b.price !== undefined ? money(b.price, 'Preço') : existing?.price,
    priceFrom: bool(b.priceFrom, existing?.priceFrom ?? false),
    duration: b.duration !== undefined ? Number(b.duration) : existing?.duration,
    desc: b.desc !== undefined ? str(b.desc, 300) : existing?.desc ?? '',
    badge: b.badge !== undefined ? str(b.badge, 30) : existing?.badge ?? '',
    active: bool(b.active, existing?.active ?? true),
    order: int(b.order, existing?.order ?? 9999),
  };
  if (!ID_RE.test(s.id)) throw new HttpError(422, 'Código do serviço: use de 2 a 40 letras minúsculas, números ou _');
  if (!s.name || s.name.length < 2) throw new HttpError(422, 'Informe o nome do serviço');
  if (!CATEGORY_IDS.includes(s.category)) throw new HttpError(422, 'Categoria inválida');
  if (s.price === undefined) throw new HttpError(422, 'Informe o preço');
  if (!Number.isInteger(s.duration) || s.duration < GRANULE || s.duration > 480 || s.duration % GRANULE) {
    throw new HttpError(422, 'Duração: de 5 a 480 minutos, de 5 em 5');
  }
  return s;
}

export function validateBarber(input, existing = null) {
  const b = input || {};
  const v = {
    id: existing ? existing.id : str(b.id, 40).toLowerCase(),
    name: b.name !== undefined ? str(b.name, 40) : existing?.name,
    title: b.title !== undefined ? str(b.title, 60) : existing?.title ?? '',
    bio: b.bio !== undefined ? str(b.bio, 300) : existing?.bio ?? '',
    photo: b.photo !== undefined ? str(b.photo, 120) : existing?.photo ?? '',
    color: b.color !== undefined ? str(b.color, 7).toLowerCase() : existing?.color ?? '#c9a46a',
    schedule: existing?.schedule ?? null,
    skipServices: existing?.skipServices ?? [],
    prices: existing?.prices ?? {},
    commissionPercent: b.commissionPercent !== undefined ? Number(b.commissionPercent) : existing?.commissionPercent ?? 0,
    active: bool(b.active, existing?.active ?? true),
    order: int(b.order, existing?.order ?? 0),
  };
  if (!ID_RE.test(v.id)) throw new HttpError(422, 'Código do barbeiro: use de 2 a 40 letras minúsculas, números ou _');
  if (!v.name || v.name.length < 2) throw new HttpError(422, 'Informe o nome do barbeiro');
  // só arquivos de imagem do próprio site (nada de endereços externos ou HTML)
  if (v.photo && !PHOTO_RE.test(v.photo)) throw new HttpError(422, 'Foto: informe só o nome do arquivo, ex.: renan.webp');
  if (!/^#[0-9a-f]{6}$/.test(v.color)) throw new HttpError(422, 'Cor inválida');
  if (!(v.commissionPercent >= 0 && v.commissionPercent <= 100)) throw new HttpError(422, 'Comissão: de 0% a 100%');
  if (b.schedule !== undefined) {
    try {
      v.schedule = normalizeSchedule(b.schedule);
    } catch (e) {
      throw new HttpError(422, e.message);
    }
  }
  if (b.skipServices !== undefined) {
    if (!Array.isArray(b.skipServices)) throw new HttpError(422, 'Lista de serviços inválida');
    v.skipServices = [...new Set(b.skipServices.filter(id => typeof id === 'string' && ID_RE.test(id)))].slice(0, 200);
  }
  if (b.prices !== undefined) {
    if (!b.prices || typeof b.prices !== 'object' || Array.isArray(b.prices)) throw new HttpError(422, 'Preços inválidos');
    v.prices = Object.fromEntries(Object.entries(b.prices).slice(0, 200)
      .filter(([id, price]) => ID_RE.test(id) && price !== '' && price !== null)
      .map(([id, price]) => [id, money(price, 'Preço do barbeiro')]));
  }
  return v;
}

export function validateStoreSettings(input) {
  const b = input || {};
  const out = {};
  if (b.storeName !== undefined) {
    out.storeName = str(b.storeName, 80);
    if (!out.storeName) throw new HttpError(422, 'Informe o nome da barbearia');
  }
  if (b.whatsappPhone !== undefined) {
    out.whatsappPhone = String(b.whatsappPhone).replace(/\D/g, '');
    if (out.whatsappPhone && !/^\d{12,13}$/.test(out.whatsappPhone)) throw new HttpError(422, 'WhatsApp: use 55 + DDD + número');
  }
  if (b.address !== undefined) out.address = str(b.address, 120);
  if (b.city !== undefined) out.city = str(b.city, 60);
  if (b.instagram !== undefined) {
    // aceita "@perfil", "perfil" ou o link do perfil
    out.instagram = str(b.instagram, 120).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?].*$/, '');
    if (out.instagram && !/^[A-Za-z0-9._]{1,30}$/.test(out.instagram)) throw new HttpError(422, 'Instagram: informe o @ do perfil');
  }
  if (b.mapsUrl !== undefined) {
    out.mapsUrl = str(b.mapsUrl, 300);
    if (out.mapsUrl) {
      let ok = false;
      try {
        const url = new URL(out.mapsUrl);
        ok = url.protocol === 'https:' && /(^|\.)(google\.com|google\.com\.br|goo\.gl)$/.test(url.hostname);
      } catch { /* inválido */ }
      if (!ok) throw new HttpError(422, 'Mapa: cole o link do Google Maps (https://maps.app.goo.gl/...)');
    }
  }
  if (b.hours !== undefined) {
    try {
      out.hours = normalizeHours(b.hours);
    } catch (e) {
      throw new HttpError(422, e.message);
    }
  }
  if (b.slotInterval !== undefined) {
    out.slotInterval = Number(b.slotInterval);
    if (!SLOT_INTERVALS.includes(out.slotInterval)) throw new HttpError(422, `Intervalo da agenda: ${SLOT_INTERVALS.join(', ')} minutos`);
  }
  if (b.minNoticeMinutes !== undefined) out.minNoticeMinutes = intIn(b.minNoticeMinutes, 0, 1440, 'Antecedência mínima (minutos)');
  if (b.maxDaysAhead !== undefined) out.maxDaysAhead = intIn(b.maxDaysAhead, 1, 120, 'Dias à frente');
  if (b.cancelHours !== undefined) out.cancelHours = intIn(b.cancelHours, 0, 72, 'Prazo para cancelar (horas)');
  if (b.paused !== undefined) out.paused = Boolean(b.paused);
  if (b.pauseMessage !== undefined) out.pauseMessage = str(b.pauseMessage, 120);
  return out;
}

// ---------- Escrita ----------

export async function saveStoreSettings(db, values, username) {
  for (const [key, value] of Object.entries(values)) {
    await db.query(
      `INSERT INTO store_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), username]
    );
  }
}

export async function upsertService(db, s) {
  await db.query(
    `INSERT INTO services (id, name, category, price, price_from, duration_min, description, badge, active, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price,
       price_from = EXCLUDED.price_from, duration_min = EXCLUDED.duration_min, description = EXCLUDED.description,
       badge = EXCLUDED.badge, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = now()`,
    [s.id, s.name, s.category, s.price, s.priceFrom, s.duration, s.desc, s.badge, s.active, s.order]
  );
}

export async function upsertBarber(db, b) {
  await db.query(
    `INSERT INTO barbers (id, name, title, bio, photo, color, schedule, skip_services, prices, commission_percent, active, sort_order, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title, bio = EXCLUDED.bio, photo = EXCLUDED.photo,
       color = EXCLUDED.color, schedule = EXCLUDED.schedule, skip_services = EXCLUDED.skip_services, prices = EXCLUDED.prices,
       commission_percent = EXCLUDED.commission_percent, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = now()`,
    [b.id, b.name, b.title, b.bio, b.photo, b.color, b.schedule ? JSON.stringify(b.schedule) : null, JSON.stringify(b.skipServices),
      JSON.stringify(b.prices), b.commissionPercent, b.active, b.order]
  );
}

// ---------- Dados iniciais (db/seed) ----------

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Preenche serviços, barbeiros e configurações a partir de db/seed/ quando ainda estão vazios. */
export async function seedCatalog(db, dir = 'db/seed') {
  const [{ n: serviceCount }] = await db.query('SELECT count(*)::int AS n FROM services');
  if (serviceCount === 0) {
    for (const [i, s] of readJson(path.join(dir, 'services.json')).entries()) {
      await upsertService(db, validateService({ ...s, order: (i + 1) * 10, active: s.active !== false }));
    }
  }

  const [{ n: barberCount }] = await db.query('SELECT count(*)::int AS n FROM barbers');
  if (barberCount === 0) {
    for (const [i, b] of readJson(path.join(dir, 'barbers.json')).entries()) {
      await upsertBarber(db, validateBarber({ ...b, order: (i + 1) * 10, active: b.active !== false }));
    }
  }

  for (const [key, value] of Object.entries(validateStoreSettings(readJson(path.join(dir, 'store.json'))))) {
    await db.query('INSERT INTO store_settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value), 'sistema']);
  }
}
