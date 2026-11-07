// Agendamentos feitos neste aparelho (só para facilitar a volta ao link; quem manda é a API).
import { saoPauloParts } from '../../shared/store-hours.js';

const KEY = 'hanoff-bookings';
const MAX = 6;

function read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.filter(b => b && typeof b.token === 'string') : [];
  } catch {
    return [];
  }
}

function write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* sem armazenamento */ }
}

export function saveBooking(booking) {
  write([booking, ...read().filter(b => b.token !== booking.token)]);
}

export function forgetBooking(token) {
  write(read().filter(b => b.token !== token));
}

/** Próximos horários marcados neste aparelho (os que já passaram saem da lista). */
export function upcomingBookings(now = new Date()) {
  const { day, minutes } = saoPauloParts(now);
  const nowKey = `${day} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const list = read();
  const upcoming = list.filter(b => `${b.day} ${b.time}` >= nowKey);
  if (upcoming.length !== list.length) write(upcoming);
  return upcoming.sort((a, b) => `${a.day} ${a.time}`.localeCompare(`${b.day} ${b.time}`));
}
