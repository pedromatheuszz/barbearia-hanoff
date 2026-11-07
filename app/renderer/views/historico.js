// Histórico de agendamentos: busca por período, cliente, código, status e barbeiro; exporta CSV
import { h, icon, btn, money, phone, PAYMENT, STATUS, statusPill, paymentPill, toast, input, searchInput, select, todayISO, shiftDays, skeleton, emptyState, dayShort } from '../ui.js';
import { get } from '../api.js';
import { loadCatalog } from '../app.js';
import { openAppointment } from './agenda.js';

function toCsv(list) {
  // Texto digitado pelo cliente (nome, observação) não pode virar fórmula no Excel
  // ("=HYPERLINK(...)" etc.): células que começam com = + - @ ganham um apóstrofo na frente.
  const cell = (v) => {
    let text = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const head = ['Código', 'Dia', 'Início', 'Fim', 'Cliente', 'Telefone', 'Barbeiro', 'Serviços', 'Valor', 'Recebido', 'Pagamento', 'Status', 'Origem', 'Observações'];
  const rows = list.map(a => [
    a.code, a.day.split('-').reverse().join('/'), a.start, a.end, a.customerName, a.customerPhone, a.barberName,
    a.services.map(s => s.name).join(' + '), a.price, a.paidAmount ?? '', PAYMENT[a.paymentMethod] || '', STATUS[a.status].long,
    a.source === 'site' ? 'Site' : 'App', a.notes,
  ].map((v) => (typeof v === 'number' ? String(v).replace('.', ',') : v)).map(cell).join(';'));
  return '﻿' + [head.map(cell).join(';'), ...rows].join('\r\n');
}

export default {
  id: 'historico',
  label: 'Histórico',
  title: 'Histórico de agendamentos',
  subtitle: 'Encontre qualquer agendamento por período, cliente, telefone, número ou barbeiro.',
  icon: 'history',
  group: 'Operação',
  permission: 'agenda.history',
  render(container, { actions }) {
    const today = todayISO();
    const from = input({ type: 'date', value: shiftDays(today, -29) });
    const to = input({ type: 'date', value: shiftDays(today, 30) });
    const q = searchInput({ placeholder: 'Nome, telefone ou nº' });
    const status = select([['', 'Todos os status'], ...Object.entries(STATUS).map(([k, v]) => [k, v.long])], '');
    const barber = select([['', 'Todos os barbeiros']], '');
    const info = h('span', { class: 'muted' });
    const tableWrap = h('div', { class: 'card card--flush' });
    const pager = h('div', { class: 'row', style: { marginTop: '1rem', justifyContent: 'center' } });
    let page = 1;
    let last = null;

    [from, to].forEach(i => { i.style.width = '150px'; });
    q.style.width = '230px';
    status.style.width = '200px';
    barber.style.width = '170px';
    loadCatalog().then(c => barber.replaceChildren(...[['', 'Todos os barbeiros'], ...c.barbers.map(b => [b.id, b.name])].map(([v, l]) => h('option', { value: v }, l)))).catch(() => {});
    const quick = (label, f, t) => h('button', { type: 'button', class: 'chip', onclick: () => { from.value = f; to.value = t; page = 1; load(); } }, label);
    const form = h('form', { class: 'toolbar', onsubmit: (e) => { e.preventDefault(); page = 1; load(); } },
      h('div', { class: 'chips' }, quick('Hoje', today, today), quick('7 dias', shiftDays(today, -6), today), quick('Próximos', today, shiftDays(today, 60)), quick('30 dias', shiftDays(today, -29), today)),
      from, h('span', { class: 'faint' }, 'até'), to, q, barber, status,
      h('button', { class: 'btn btn--primary' }, icon('search'), h('span', {}, 'Buscar')), h('div', { class: 'spacer' }), info);
    container.append(form, tableWrap, pager);

    actions.append(btn('Exportar CSV', {
      icon: 'download', size: 'sm',
      onclick: async () => {
        if (!last?.total) return toast('Nada para exportar', 'error');
        const all = [];
        for (let p = 1; p <= Math.ceil(last.total / last.pageSize); p++) all.push(...(await get(url(p))).appointments);
        const a = h('a', { href: URL.createObjectURL(new Blob([toCsv(all)], { type: 'text/csv;charset=utf-8' })), download: `agendamentos_${from.value}_a_${to.value}.csv` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      },
    }));

    const url = (p) => `/api/admin/appointments?${new URLSearchParams({ from: from.value, to: to.value, q: q.input.value, status: status.value, barber: barber.value, page: String(p) })}`;

    async function load() {
      tableWrap.replaceChildren(h('div', { style: { padding: '1rem' } }, skeleton(6)));
      try {
        last = await get(url(page));
      } catch (error) {
        tableWrap.replaceChildren(emptyState('Não foi possível buscar', error.message, 'wifiOff'));
        return;
      }
      const received = last.appointments.filter(a => a.status === 'concluido').reduce((t, a) => t + (a.paidAmount || 0), 0);
      info.textContent = last.total === 1 ? '1 agendamento' : `${last.total} agendamentos`;
      if (!last.appointments.length) {
        tableWrap.replaceChildren(emptyState('Nenhum agendamento encontrado', 'Tente outro período ou outra busca.', 'search'));
        pager.replaceChildren();
        return;
      }
      tableWrap.replaceChildren(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Nº', 'Quando', 'Cliente', 'Serviços', 'Barbeiro', 'Pagamento', 'Status'].map(t => h('th', {}, t)), h('th', { class: 'right' }, 'Valor'))),
        h('tbody', {}, last.appointments.map(a => h('tr', { class: 'clickable', onclick: () => openAppointment(a.id) },
          h('td', {}, h('strong', { class: 'price' }, a.code)),
          h('td', { class: 'num' }, h('strong', {}, dayShort(a.day)), h('div', { class: 'faint' }, `${a.start}–${a.end}`)),
          h('td', {}, h('strong', {}, a.customerName), h('div', { class: 'faint' }, a.customerPhone ? phone(a.customerPhone) : 'sem telefone')),
          h('td', { class: 'muted' }, a.services.map(s => s.name).join(' + ')),
          h('td', {}, a.barberName),
          h('td', {}, paymentPill(a.paymentMethod)),
          h('td', {}, statusPill(a.status)),
          h('td', { class: 'right num' }, h('strong', { class: 'price' }, money(a.status === 'concluido' ? a.paidAmount : a.price)))))),
        h('tfoot', {}, h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'Recebido nesta página (só concluídos)'), h('td', { class: 'right num' }, h('strong', { class: 'price' }, money(received)))))));

      const pages = Math.ceil(last.total / last.pageSize);
      pager.replaceChildren(...(pages > 1 ? [
        btn('Anterior', { icon: 'chevronLeft', size: 'sm', disabled: page <= 1, onclick: () => { page--; load(); } }),
        h('span', { class: 'muted' }, `Página ${page} de ${pages}`),
        btn('Próxima', { icon: 'chevronRight', size: 'sm', disabled: page >= pages, onclick: () => { page++; load(); } }),
      ] : []));
    }

    load();
  },
};
