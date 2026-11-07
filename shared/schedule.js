// Agenda: janelas de trabalho dos barbeiros e cálculo dos horários livres (funções puras,
// usadas pela API, pelo site e pelo app; cobertas por tests/unit.test.js).
// Horários sempre em minutos desde 00:00 no horário de Brasília; dias como 'AAAA-MM-DD'.
import { toMin, toHHMM, normalizePeriod, WEEKDAYS } from './store-hours.js';

export { toMin, toHHMM };

// Menor pedaço de tempo da agenda: durações e horários são múltiplos de 5 minutos
export const GRANULE = 5;
export const SLOT_INTERVALS = [10, 15, 20, 30, 45, 60];

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Data de calendário que existe de verdade (recusa 2026-02-31) e dentro de 2000–2100. */
export function isRealDate(value) {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  const year = Number(value.slice(0, 4));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value && year >= 2000 && year <= 2100;
}

export const weekdayOf = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);

/** Minutos que faltam de agora ({ day, minutes } de Brasília) até o início de um horário. */
export const minutesUntil = (day, startMin, now) => daysBetween(now.day, day) * 1440 + startMin - now.minutes;

/** 40 → "40 min"; 70 → "1h10"; 120 → "2h" */
export function formatDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return `${Math.floor(m / 60)}h${rest ? String(rest).padStart(2, '0') : ''}`;
}

/**
 * Valida a jornada semanal de um barbeiro. null = segue o horário da barbearia.
 * Cada dia: null (folga) ou { start, end, breakStart?, breakEnd? }. Lança Error com mensagem amigável.
 */
export function normalizeSchedule(schedule) {
  if (schedule === null || schedule === undefined) return null;
  if (!Array.isArray(schedule) || schedule.length !== 7) throw new Error('Informe a jornada dos 7 dias da semana');
  return schedule.map((d, i) => (d ? normalizePeriod(d, ['start', 'end'], WEEKDAYS[i]) : null));
}

// Período com intervalo opcional → trechos [{ start, end }] em minutos
function periodWindows(p, startKey, endKey) {
  const start = toMin(p[startKey]);
  const end = toMin(p[endKey]);
  if (!p.breakStart || !p.breakEnd) return [{ start, end }];
  return [{ start, end: toMin(p.breakStart) }, { start: toMin(p.breakEnd), end }].filter(w => w.end > w.start);
}

/**
 * Janelas em que o barbeiro atende no dia da semana: o horário da barbearia (sem o almoço)
 * cruzado com a jornada dele (sem o intervalo dele). Retorna [{ start, end }] em minutos.
 */
export function workWindows(barber, hours, weekday) {
  const shop = hours?.[weekday];
  if (!shop) return [];
  const shopWindows = periodWindows(shop, 'open', 'close');
  if (!barber?.schedule) return shopWindows;
  const own = barber.schedule[weekday];
  if (!own) return [];
  const out = [];
  for (const a of shopWindows) {
    for (const b of periodWindows(own, 'start', 'end')) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** O barbeiro faz todos os serviços escolhidos? */
export const doesAll = (barber, serviceIds) => !serviceIds.some(id => (barber.skipServices || []).includes(id));

/**
 * Horários livres de um dia.
 * - barbers: barbeiros candidatos (ativos, que fazem os serviços), na ordem de preferência
 * - busy: [{ barberId, start, end }] agendamentos ativos e bloqueios (barberId null = todos)
 * - notBefore: minuto a partir do qual pode começar (agora + antecedência, se for hoje)
 * Retorna [{ time: 'HH:MM', start, barbers: [ids] }] em ordem; cada lista de barbeiros
 * mantém a ordem recebida.
 */
export function computeSlots({ day, duration, barbers, hours, busy = [], interval = 30, notBefore = 0 }) {
  const weekday = weekdayOf(day);
  const byStart = new Map();
  for (const barber of barbers) {
    const mine = busy.filter(b => b.barberId === barber.id || b.barberId === null);
    for (const w of workWindows(barber, hours, weekday)) {
      for (let t = w.start; t + duration <= w.end; t += interval) {
        if (t < notBefore) continue;
        if (mine.some(b => t < b.end && t + duration > b.start)) continue;
        if (!byStart.has(t)) byStart.set(t, []);
        byStart.get(t).push(barber.id);
      }
    }
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, ids]) => ({ time: toHHMM(start), start, barbers: ids }));
}

/** O dia tem algum barbeiro trabalhando? (o site usa para riscar os dias fechados) */
export const isWorkingDay = (day, barbers, hours) => barbers.some(b => workWindows(b, hours, weekdayOf(day)).length > 0);
