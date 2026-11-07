// Funções puras do site (sem DOM) — cobertas por tests/unit.test.js

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const formatBRL = (value) => BRL.format(Number(value) || 0);

// Escapa texto para uso seguro dentro de templates HTML (conteúdo e atributos)
export function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "47997715710" → "(47) 99771-5710" (também formata enquanto o cliente digita) */
export function maskPhone(value) {
  const d = String(value ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '').slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** Link do WhatsApp com mensagem pronta ('' se a barbearia não tiver WhatsApp cadastrado) */
export const whatsappLink = (phone, text = '') =>
  (/^\d{12,13}$/.test(String(phone || '')) ? `https://wa.me/${phone}${text ? `?text=${encodeURIComponent(text)}` : ''}` : '');

const WEEK_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const WEEK_LONG = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const parts = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  return { dow: d.getUTCDay(), date: d.getUTCDate(), month: d.getUTCMonth() };
};

/** Rótulo do dia na faixa de datas: { top: 'Hoje' | 'Amanhã' | 'qui', num: '12', month: 'nov' } */
export function dayLabel(day, today) {
  const p = parts(day);
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const top = day === today ? 'Hoje' : day === tomorrow.toISOString().slice(0, 10) ? 'Amanhã' : WEEK_SHORT[p.dow];
  return { top, num: String(p.date), month: MONTH_SHORT[p.month] };
}

/** Primeira letra maiúscula ("terça-feira" → "Terça-feira") */
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "terça-feira, 10 de novembro" */
export function longDate(day) {
  const p = parts(day);
  return `${WEEK_LONG[p.dow]}, ${p.date} de ${MONTH_LONG[p.month]}`;
}

/** "ter, 10/11" */
export function shortDate(day) {
  const p = parts(day);
  return `${WEEK_SHORT[p.dow]}, ${String(p.date).padStart(2, '0')}/${String(p.month + 1).padStart(2, '0')}`;
}

/** Separa os horários em Manhã (até 12h), Tarde (até 18h) e Noite */
export function groupSlots(slots) {
  const groups = [
    { label: 'Manhã', icon: 'sun', slots: [] },
    { label: 'Tarde', icon: 'clock', slots: [] },
    { label: 'Noite', icon: 'moon', slots: [] },
  ];
  for (const s of slots) {
    const h = Number(s.time.slice(0, 2));
    groups[h < 12 ? 0 : h < 18 ? 1 : 2].slots.push(s);
  }
  return groups.filter(g => g.slots.length);
}

// Texto dentro do .ics: vírgula, ponto e vírgula, barra e quebra de linha escapados
const icsText = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => `\\${m}`).replace(/\r?\n/g, '\\n');
const icsTime = (day, minutes) => `${day.replace(/-/g, '')}T${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}00`;

/** Arquivo de calendário (.ics) do agendamento, no horário de Brasília */
export function buildIcs({ uid, title, day, time, duration, location = '', description = '' }) {
  const start = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Barbearia Hanoff//Agendamento//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${icsText(uid)}@barbeariahanoff`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=America/Sao_Paulo:${icsTime(day, start)}`,
    `DTEND;TZID=America/Sao_Paulo:${icsTime(day, start + duration)}`,
    `SUMMARY:${icsText(title)}`,
    location ? `LOCATION:${icsText(location)}` : null,
    description ? `DESCRIPTION:${icsText(description)}` : null,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter(line => line !== null).join('\r\n');
}

/** Identificador aleatório do agendamento (o mesmo envio repetido não vira dois horários) */
export function newClientRef() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `bk-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
