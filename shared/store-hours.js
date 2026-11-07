// Horário de funcionamento (horário de Brasília). Usado pelo site, pela API e pelo app de gestão.
// hours: array de 7 posições (0 = domingo) com { open, close, breakStart?, breakEnd? } ('HH:MM')
// ou null (fechado). O intervalo (almoço) é opcional.

export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const full = { open: '09:00', close: '20:00', breakStart: '12:00', breakEnd: '13:30' };
export const DEFAULT_HOURS = [null, { open: '13:30', close: '20:00' }, full, full, full, full, { open: '08:00', close: '18:00', breakStart: '12:00', breakEnd: '13:00' }];

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Valida um período do dia com intervalo opcional. keys = nomes do início e do fim
 * ('open'/'close' na barbearia, 'start'/'end' na jornada do barbeiro). Lança Error.
 */
export function normalizePeriod(p, [startKey, endKey], label) {
  if (!TIME_RE.test(p?.[startKey] || '') || !TIME_RE.test(p?.[endKey] || '')) throw new Error(`Horário inválido na ${label}`);
  const start = toMin(p[startKey]);
  const end = toMin(p[endKey]);
  // a agenda é montada dentro do mesmo dia: o fim vem depois do início
  if (end <= start) throw new Error(`Na ${label}, o fim precisa ser depois do início`);
  const out = { [startKey]: p[startKey], [endKey]: p[endKey] };
  if (p.breakStart || p.breakEnd) {
    if (!TIME_RE.test(p.breakStart || '') || !TIME_RE.test(p.breakEnd || '')) throw new Error(`Intervalo inválido na ${label}`);
    const bs = toMin(p.breakStart);
    const be = toMin(p.breakEnd);
    if (be <= bs || bs <= start || be >= end) throw new Error(`Na ${label}, o intervalo precisa ficar dentro do horário`);
    out.breakStart = p.breakStart;
    out.breakEnd = p.breakEnd;
  }
  return out;
}

/** Valida e normaliza a grade de horários da barbearia. Lança Error com mensagem amigável. */
export function normalizeHours(hours) {
  if (!Array.isArray(hours) || hours.length !== 7) throw new Error('Informe o horário dos 7 dias da semana');
  return hours.map((h, i) => (h ? normalizePeriod(h, ['open', 'close'], WEEKDAYS[i]) : null));
}

/** "09:00 às 12:00 e 13:30 às 20:00" */
export function describeDay(h) {
  if (!h) return 'Fechado';
  return h.breakStart ? `${h.open} às ${h.breakStart} e ${h.breakEnd} às ${h.close}` : `${h.open} às ${h.close}`;
}

/** Data (AAAA-MM-DD), dia da semana e minutos desde 00:00 num instante, no horário de Brasília. */
export function saoPauloParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/**
 * Situação da barbearia num instante. `paused` (pausa manual pelo app) suspende a agenda
 * online; `pauseMessage` substitui o texto padrão.
 */
export function getStoreStatus(date, { hours = DEFAULT_HOURS, paused = false, pauseMessage = '' } = {}) {
  const { weekday: today, minutes } = saoPauloParts(date);
  const h = hours[today];
  if (paused) {
    return { open: false, paused: true, label: pauseMessage ? `Agenda pausada • ${pauseMessage}` : 'Agenda online pausada • Fale com a gente no WhatsApp' };
  }
  if (h && minutes >= toMin(h.open) && minutes < toMin(h.close)) {
    if (h.breakStart && minutes >= toMin(h.breakStart) && minutes < toMin(h.breakEnd)) {
      return { open: false, label: `Pausa para o almoço • Voltamos às ${h.breakEnd}` };
    }
    return { open: true, label: `Aberto agora • Até as ${h.breakStart && minutes < toMin(h.breakStart) ? h.breakStart : h.close}` };
  }
  if (h && minutes < toMin(h.open)) {
    return { open: false, label: `Fechado • Abrimos hoje às ${h.open}` };
  }
  for (let i = 1; i <= 7; i++) {
    const next = (today + i) % 7;
    if (hours[next]) {
      const when = i === 1 ? 'amanhã' : WEEKDAYS[next];
      return { open: false, label: `Fechado • Abrimos ${when} às ${hours[next].open}` };
    }
  }
  return { open: false, label: 'Fechado no momento' };
}
