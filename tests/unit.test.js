/**
 * Testes unitários das regras compartilhadas (site, API e app) e das funções puras do site.
 */
import { describe, it, expect } from 'vitest';
import { getStoreStatus, normalizeHours, describeDay, saoPauloParts, DEFAULT_HOURS } from '../shared/store-hours.js';
import {
  computeSlots, workWindows, normalizeSchedule, isRealDate, addDays, weekdayOf, minutesUntil, formatDuration, isWorkingDay, doesAll,
} from '../shared/schedule.js';
import { summarize, priceFor, pickServices } from '../shared/services.js';
import { cleanText } from '../server/text.js';
import { formatBRL, escapeHTML, maskPhone, buildIcs, dayLabel, groupSlots, whatsappLink } from '../site/src/utils.js';

// Horário de Brasília = UTC−3
const at = (iso) => new Date(`${iso}-03:00`);
const HOURS = DEFAULT_HOURS; // seg 13:30–20:00; ter–sex 09:00–12:00 e 13:30–20:00; sáb 08:00–12:00 e 13:00–18:00
const TUE = '2026-11-10';

describe('horário de funcionamento', () => {
  it('aberto, almoço, fechado e próxima abertura', () => {
    expect(getStoreStatus(at('2026-11-10T10:00:00'), { hours: HOURS })).toMatchObject({ open: true, label: 'Aberto agora • Até as 12:00' });
    expect(getStoreStatus(at('2026-11-10T12:30:00'), { hours: HOURS })).toMatchObject({ open: false, label: 'Pausa para o almoço • Voltamos às 13:30' });
    expect(getStoreStatus(at('2026-11-10T15:00:00'), { hours: HOURS }).label).toBe('Aberto agora • Até as 20:00');
    expect(getStoreStatus(at('2026-11-09T10:00:00'), { hours: HOURS }).label).toBe('Fechado • Abrimos hoje às 13:30');
    expect(getStoreStatus(at('2026-11-07T19:00:00'), { hours: HOURS }).label).toBe('Fechado • Abrimos segunda às 13:30');
    expect(getStoreStatus(at('2026-11-08T10:00:00'), { hours: HOURS }).label).toBe('Fechado • Abrimos amanhã às 13:30');
  });

  it('pausa manual vale mesmo dentro do horário', () => {
    const s = getStoreStatus(at('2026-11-10T10:00:00'), { hours: HOURS, paused: true, pauseMessage: 'Voltamos às 15h' });
    expect(s).toMatchObject({ open: false, paused: true, label: 'Agenda pausada • Voltamos às 15h' });
  });

  it('valida a grade com intervalo de almoço', () => {
    const ok = Array(7).fill({ open: '09:00', close: '20:00', breakStart: '12:00', breakEnd: '13:00' });
    expect(normalizeHours(ok)[1]).toEqual({ open: '09:00', close: '20:00', breakStart: '12:00', breakEnd: '13:00' });
    expect(() => normalizeHours(ok.map((h, i) => (i === 2 ? { open: '20:00', close: '09:00' } : h)))).toThrow(/terça/);
    expect(() => normalizeHours(ok.map((h, i) => (i === 3 ? { ...h, breakEnd: '21:00' } : h)))).toThrow(/intervalo/);
    expect(() => normalizeHours(ok.slice(1))).toThrow();
    expect(describeDay(HOURS[2])).toBe('09:00 às 12:00 e 13:30 às 20:00');
    expect(describeDay(null)).toBe('Fechado');
  });

  it('data e hora de Brasília', () => {
    expect(saoPauloParts(new Date('2026-11-08T02:30:00Z'))).toEqual({ day: '2026-11-07', weekday: 6, minutes: 23 * 60 + 30 });
  });
});

describe('agenda: janelas e horários livres', () => {
  const barber = (id, extra = {}) => ({ id, order: 0, ...extra });

  it('janela do barbeiro = horário da barbearia ∩ jornada dele, sem os intervalos', () => {
    expect(workWindows(barber('a'), HOURS, 2)).toEqual([{ start: 540, end: 720 }, { start: 810, end: 1200 }]);
    const half = Array(7).fill({ start: '11:00', end: '16:00', breakStart: '14:00', breakEnd: '14:30' });
    expect(workWindows(barber('b', { schedule: half }), HOURS, 2)).toEqual([{ start: 660, end: 720 }, { start: 810, end: 840 }, { start: 870, end: 960 }]);
    expect(workWindows(barber('c', { schedule: Array(7).fill(null) }), HOURS, 2)).toEqual([]);
    expect(workWindows(barber('d'), HOURS, 0)).toEqual([]); // domingo fechado
  });

  it('calcula os horários pela duração, intervalo, ocupados e antecedência', () => {
    const slots = computeSlots({
      day: TUE, duration: 30, barbers: [barber('a'), barber('b')], hours: HOURS, interval: 30,
      busy: [{ barberId: 'a', start: 540, end: 600 }, { barberId: null, start: 900, end: 960 }], notBefore: 0,
    });
    const at9 = slots.find(s => s.time === '09:00');
    expect(at9.barbers).toEqual(['b']);
    expect(slots.find(s => s.time === '10:00').barbers).toEqual(['a', 'b']);
    expect(slots.some(s => s.time === '15:00' || s.time === '15:30')).toBe(false); // bloqueio de todos
    expect(slots.some(s => s.time === '12:00')).toBe(false);
    const fits = computeSlots({ day: TUE, duration: 60, barbers: [barber('a')], hours: HOURS, interval: 30, notBefore: 11 * 60 });
    expect(fits[0].time).toBe('11:00'); // termina exatamente no início do almoço
    const later = computeSlots({ day: TUE, duration: 60, barbers: [barber('a')], hours: HOURS, interval: 30, notBefore: 11 * 60 + 10 });
    expect(later[0].time).toBe('13:30'); // 11:30 + 1h passaria do almoço
  });

  it('serviços que o barbeiro não faz e dias sem ninguém', () => {
    expect(doesAll({ skipServices: ['luzes'] }, ['corte'])).toBe(true);
    expect(doesAll({ skipServices: ['luzes'] }, ['corte', 'luzes'])).toBe(false);
    expect(isWorkingDay('2026-11-08', [barber('a')], HOURS)).toBe(false);
    expect(isWorkingDay(TUE, [barber('a')], HOURS)).toBe(true);
  });

  it('valida a jornada semanal', () => {
    expect(normalizeSchedule(null)).toBeNull();
    expect(() => normalizeSchedule(Array(7).fill({ start: '10:00', end: '09:00' }))).toThrow(/domingo/);
    expect(() => normalizeSchedule([{ start: '09:00', end: '18:00', breakStart: '08:00', breakEnd: '09:30' }, null, null, null, null, null, null])).toThrow(/intervalo/);
  });

  it('datas e durações', () => {
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(weekdayOf(TUE)).toBe(2);
    expect(minutesUntil(TUE, 600, { day: '2026-11-09', minutes: 1380 })).toBe(60 + 600);
    expect([formatDuration(40), formatDuration(60), formatDuration(70)]).toEqual(['40 min', '1h', '1h10']);
  });
});

describe('serviços e preços', () => {
  const corte = { id: 'corte', price: 45, duration: 30 };
  const barba = { id: 'barba', price: 40, duration: 30 };
  const renan = { prices: { corte: 55 } };

  it('preço próprio do barbeiro e resumo da escolha', () => {
    expect(priceFor(corte, renan)).toBe(55);
    expect(priceFor(barba, renan)).toBe(40);
    expect(summarize([corte, barba])).toEqual({ price: 85, duration: 60, priceFrom: false });
    expect(summarize([corte, barba], renan).price).toBe(95);
    expect(summarize([{ ...corte, priceFrom: true }]).priceFrom).toBe(true);
  });

  it('escolha ignora repetidos e desconhecidos e segue a ordem do catálogo', () => {
    const byId = new Map([['corte', corte], ['barba', barba]]);
    expect(pickServices(['barba', 'corte', 'corte', 'xxx'], byId).map(s => s.id)).toEqual(['corte', 'barba']);
  });

  it('limpa texto digitado pelo cliente', () => {
    expect(cleanText(' Ana\u0000 ‮Souza ', 80)).toBe('Ana Souza');
    expect(cleanText('linha 1\r\n\r\n\r\nlinha 2', 80, { multiline: true })).toBe('linha 1\n\nlinha 2');
  });
});

describe('site: funções puras', () => {
  it('formata dinheiro, telefone e escapa HTML', () => {
    expect(formatBRL(45)).toMatch(/R\$\s?45,00/);
    expect(maskPhone('47997715710')).toBe('(47) 99771-5710');
    expect(maskPhone('4733334444')).toBe('(47) 3333-4444');
    expect(escapeHTML('<b a="1">&\'')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#39;');
  });

  it('rótulos dos dias e grupos de horários', () => {
    expect(dayLabel('2026-11-10', '2026-11-10')).toMatchObject({ top: 'Hoje', num: '10' });
    expect(dayLabel('2026-11-11', '2026-11-10').top).toBe('Amanhã');
    expect(dayLabel('2026-11-12', '2026-11-10').top).toBe('qui');
    const groups = groupSlots([{ time: '09:00' }, { time: '13:30' }, { time: '18:00' }]);
    expect(groups.map(g => [g.label, g.slots.length])).toEqual([['Manhã', 1], ['Tarde', 1], ['Noite', 1]]);
  });

  it('link do WhatsApp com mensagem', () => {
    expect(whatsappLink('5547997715710', 'Olá & tchau')).toBe('https://wa.me/5547997715710?text=Ol%C3%A1%20%26%20tchau');
    expect(whatsappLink('', 'x')).toBe('');
  });

  it('arquivo de calendário (.ics) no horário de Brasília', () => {
    const ics = buildIcs({ uid: 'abc', title: 'Corte • Barbearia', day: '2026-11-10', time: '14:00', duration: 45, location: 'R. Florianópolis, 3001', description: 'Linha 1\nLinha 2' });
    expect(ics).toContain('DTSTART;TZID=America/Sao_Paulo:20261110T140000');
    expect(ics).toContain('DTEND;TZID=America/Sao_Paulo:20261110T144500');
    expect(ics).toContain('LOCATION:R. Florianópolis\\, 3001');
    expect(ics).toContain('DESCRIPTION:Linha 1\\nLinha 2');
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  });
});
