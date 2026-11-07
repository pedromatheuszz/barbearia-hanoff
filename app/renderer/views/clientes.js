// Clientes (agrupados pelo telefone): frequência, última visita, faltas e histórico de cada um
import { h, icon, btn, money, phone, modal, searchInput, skeleton, emptyState, statusPill, dayShort, waLink, toast } from '../ui.js';
import { get } from '../api.js';
import { can } from '../app.js';
import { openAppointment, openNewAppointment } from './agenda.js';

const daysAgo = (day) => {
  if (!day) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  return Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
};

async function openClient(c) {
  let data;
  try {
    data = await get(`/api/admin/clients/${c.phone}`);
  } catch (error) {
    return toast(error.message, 'error');
  }
  const ago = daysAgo(c.lastVisit);
  modal({
    title: c.name,
    icon: 'contact',
    wide: true,
    body: h('div', {},
      h('div', { class: 'stat-inline' },
        h('div', {}, h('strong', {}, String(c.visits)), h('span', {}, 'atendimentos')),
        h('div', {}, h('strong', {}, money(c.spent)), h('span', {}, 'gasto no total')),
        h('div', {}, h('strong', {}, c.visits ? money(c.spent / c.visits) : '—'), h('span', {}, 'ticket médio')),
        h('div', {}, h('strong', {}, ago === null ? '—' : ago === 0 ? 'hoje' : `${ago} dia${ago === 1 ? '' : 's'}`), h('span', {}, 'desde a última visita')),
        h('div', {}, h('strong', { class: c.noShows ? 'neg' : '' }, String(c.noShows)), h('span', {}, 'faltas'))),
      h('div', { class: 'card card--flush' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Nº', 'Quando', 'Serviços', 'Barbeiro', 'Status'].map(t => h('th', {}, t)), h('th', { class: 'right' }, 'Valor'))),
        h('tbody', {}, data.appointments.map(a => h('tr', { class: 'clickable', onclick: () => openAppointment(a.id) },
          h('td', {}, h('strong', {}, a.code)), h('td', { class: 'num' }, `${dayShort(a.day)} ${a.start}`),
          h('td', { class: 'muted' }, a.services.map(s => s.name).join(' + ')), h('td', {}, a.barberName),
          h('td', {}, statusPill(a.status)), h('td', { class: 'right num' }, money(a.status === 'concluido' ? a.paidAmount : a.price)))))))),
    actions: [
      { label: 'WhatsApp', icon: 'whatsapp', left: true, onClick: () => { window.gestao.openExternal(waLink(c.phone, `Olá, ${c.name.split(' ')[0]}!`)); return false; } },
      { label: 'Fechar' },
      can('agenda.book') ? { label: 'Agendar', kind: 'primary', icon: 'calendarPlus', onClick: () => openNewAppointment({}) } : null,
    ].filter(Boolean),
  });
}

export default {
  id: 'clientes',
  label: 'Clientes',
  subtitle: 'Quem vem, com que frequência, quanto gasta e quem anda sumido. Agrupado pelo telefone.',
  icon: 'contact',
  group: 'Operação',
  permission: 'clients.view',
  render(container) {
    let page = 1;
    let timer = null;
    const q = searchInput({ placeholder: 'Buscar por nome ou telefone', oninput: () => { clearTimeout(timer); timer = setTimeout(() => { page = 1; load(); }, 300); } });
    q.style.width = '320px';
    const info = h('span', { class: 'muted' });
    const tableWrap = h('div', { class: 'card card--flush' });
    const pager = h('div', { class: 'row', style: { marginTop: '1rem', justifyContent: 'center' } });
    container.append(h('div', { class: 'toolbar' }, q, h('div', { class: 'spacer' }), info), tableWrap, pager);

    async function load() {
      tableWrap.replaceChildren(h('div', { style: { padding: '1rem' } }, skeleton(6)));
      let data;
      try {
        data = await get(`/api/admin/clients?${new URLSearchParams({ q: q.input.value, page: String(page) })}`);
      } catch (error) {
        tableWrap.replaceChildren(emptyState('Não foi possível carregar', error.message, 'wifiOff'));
        return;
      }
      info.textContent = data.total === 1 ? '1 cliente' : `${data.total} clientes`;
      if (!data.clients.length) {
        tableWrap.replaceChildren(emptyState('Nenhum cliente encontrado', q.input.value ? 'Tente outro nome ou telefone.' : 'Os clientes aparecem aqui depois do primeiro agendamento com telefone.', 'contact'));
        pager.replaceChildren();
        return;
      }
      tableWrap.replaceChildren(h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Cliente'), h('th', { class: 'right' }, 'Atendimentos'), h('th', {}, 'Última visita'), h('th', {}, 'Próximo horário'), h('th', {}, 'Barbeiro de sempre'), h('th', { class: 'right' }, 'Faltas'), h('th', { class: 'right' }, 'Gasto total'))),
        h('tbody', {}, data.clients.map(c => {
          const ago = daysAgo(c.lastVisit);
          return h('tr', { class: 'clickable', onclick: () => openClient(c) },
            h('td', {}, h('div', { class: 'client-name' }, h('div', { class: 'avatar', style: { width: '30px', height: '30px', fontSize: '13px' } }, c.name.slice(0, 1).toUpperCase()),
              h('div', {}, h('strong', {}, c.name), h('div', { class: 'faint' }, phone(c.phone))))),
            h('td', { class: 'right num' }, h('strong', {}, String(c.visits))),
            h('td', { class: 'num' }, c.lastVisit ? [dayShort(c.lastVisit), h('div', { class: ago > 45 ? 'neg' : 'faint', style: { fontSize: '12px' } }, ago === 0 ? 'hoje' : `há ${ago} dia${ago === 1 ? '' : 's'}`)] : h('span', { class: 'faint' }, '—')),
            h('td', { class: 'num' }, c.nextVisit ? h('span', { class: 'pill pill--info' }, icon('calendar'), dayShort(c.nextVisit)) : h('span', { class: 'faint' }, '—')),
            h('td', {}, c.barber || '—'),
            h('td', { class: 'right num' }, c.noShows ? h('span', { class: 'pill pill--danger' }, String(c.noShows)) : h('span', { class: 'faint' }, '0')),
            h('td', { class: 'right num' }, h('strong', { class: 'price' }, money(c.spent))));
        }))));
      const pages = Math.ceil(data.total / data.pageSize);
      pager.replaceChildren(...(pages > 1 ? [
        btn('Anterior', { icon: 'chevronLeft', size: 'sm', disabled: page <= 1, onclick: () => { page--; load(); } }),
        h('span', { class: 'muted' }, `Página ${page} de ${pages}`),
        btn('Próxima', { icon: 'chevronRight', size: 'sm', disabled: page >= pages, onclick: () => { page++; load(); } }),
      ] : []));
    }

    load();
  },
};
