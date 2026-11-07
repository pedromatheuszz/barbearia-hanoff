// Serviços (preço, duração, ativo) e barbeiros (jornada, serviços, preço próprio, comissão).
// Tudo muda no site na hora.
import { h, icon, btn, money, toast, modal, field, input, select, textarea, toggle, confirmDialog, moneyInput, parseMoney, searchInput, skeleton, emptyState, duration, CATEGORIES, WEEKDAYS, barberAvatar } from '../ui.js';
import { post, patch, del } from '../api.js';
import { can, loadCatalog, setCatalog, state } from '../app.js';

const COLORS = ['#c9a46a', '#4f8a8b', '#b5503c', '#7b6bb0', '#5f8f4e', '#c07a3a', '#3c6e9e', '#a0527a', '#6b7280'];
const DURATIONS = Array.from({ length: 96 }, (_, i) => (i + 1) * 5);
const ORDER = [1, 2, 3, 4, 5, 6, 0];

const slugify = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function serviceForm(service, done) {
  const isNew = !service;
  const s = service || { id: '', name: '', category: 'cabelo', price: 0, priceFrom: false, duration: 30, desc: '', badge: '', active: true, order: 1000 };
  const f = {
    name: input({ value: s.name, maxlength: 80 }),
    id: input({ value: s.id, maxlength: 40, disabled: !isNew, placeholder: 'gerado pelo nome' }),
    category: select(CATEGORIES, s.category),
    price: input({ value: moneyInput(s.price), money: true, inputmode: 'decimal' }),
    duration: select(DURATIONS.map(d => [d, duration(d)]), s.duration),
    desc: textarea(s.desc, { maxlength: 300 }),
    badge: input({ value: s.badge, maxlength: 30, placeholder: 'ex.: Plano mensal, Novidade' }),
    order: input({ value: s.order, type: 'number', step: 1 }),
    priceFrom: h('input', { type: 'checkbox', checked: s.priceFrom }),
    active: h('input', { type: 'checkbox', checked: s.active }),
  };
  if (isNew) f.name.addEventListener('input', () => { f.id.value = slugify(f.name.value); });
  modal({
    title: isNew ? 'Novo serviço' : s.name,
    icon: isNew ? 'plus' : 'pencil',
    wide: true,
    body: h('div', { class: 'form-grid' },
      h('div', { class: 'span-2' }, field('Nome no site', f.name)),
      field('Categoria', f.category), field('Duração', f.duration, 'Tempo que a cadeira fica ocupada'),
      field('Preço (R$)', f.price, 'Preço de quem não tem valor próprio (veja Barbeiros)'), field('Selo (opcional)', f.badge),
      h('div', { class: 'span-2' }, field('Descrição', f.desc)),
      field('Ordem no site', f.order, 'Menor aparece primeiro'), field('Código interno', f.id, isNew ? 'Letras minúsculas, números e _' : 'Não pode ser alterado'),
      h('label', { class: 'check' }, f.priceFrom, 'Mostrar "a partir de" (valor final varia)'),
      h('label', { class: 'check' }, f.active, 'Aparece no site (ativo)')),
    actions: [
      !isNew ? {
        label: 'Excluir', kind: 'danger', icon: 'trash', left: true,
        onClick: async () => {
          if (!(await confirmDialog(`Excluir "${s.name}"? Agendamentos antigos continuam no histórico. Para tirar do site só por um tempo, prefira desligar "No site".`, { danger: true, confirmLabel: 'Excluir', title: 'Excluir serviço' }))) return false;
          setCatalog(await del(`/api/admin/catalog/services/${s.id}`));
          toast('Serviço excluído');
          done();
        },
      } : null,
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', icon: 'check', submit: true,
        onClick: async () => {
          const body = {
            name: f.name.value, category: f.category.value, price: parseMoney(f.price.value), duration: Number(f.duration.value), desc: f.desc.value,
            badge: f.badge.value, order: Number(f.order.value), priceFrom: f.priceFrom.checked, active: f.active.checked,
          };
          if (!(body.price >= 0)) throw new Error('Preço inválido');
          setCatalog(isNew ? await post('/api/admin/catalog/services', { id: f.id.value, ...body }) : await patch(`/api/admin/catalog/services/${s.id}`, body));
          toast(isNew ? 'Serviço criado' : 'Serviço atualizado');
          done();
        },
      },
    ].filter(Boolean),
  });
}

/** Jornada da semana: segue a barbearia ou horário próprio por dia (com intervalo) */
function scheduleEditor(schedule) {
  const follow = h('input', { type: 'checkbox', checked: !schedule });
  const shop = state.catalog?.settings.hours || [];
  const rows = ORDER.map(day => {
    const d = schedule ? schedule[day] : (shop[day] ? { start: shop[day].open, end: shop[day].close } : null);
    const works = h('input', { type: 'checkbox', checked: Boolean(d) });
    const start = input({ type: 'time', value: d?.start || '09:00', step: 300 });
    const end = input({ type: 'time', value: d?.end || '20:00', step: 300 });
    const bStart = input({ type: 'time', value: d?.breakStart || '', step: 300 });
    const bEnd = input({ type: 'time', value: d?.breakEnd || '', step: 300 });
    const times = h('div', { class: 'sched__times' },
      h('span', { class: 'sched__group' }, start, h('small', {}, 'às'), end),
      h('span', { class: 'sched__group' }, h('small', {}, 'intervalo'), bStart, h('small', {}, 'às'), bEnd));
    const off = h('span', { class: 'faint' }, 'Folga');
    const sync = () => {
      const enabled = !follow.checked;
      works.disabled = !enabled;
      [start, end, bStart, bEnd].forEach(i => { i.disabled = !enabled || !works.checked; });
      times.hidden = !works.checked;
      off.hidden = works.checked;
    };
    works.addEventListener('change', sync);
    return { day, works, start, end, bStart, bEnd, sync, el: h('div', { class: 'sched__row' }, h('strong', {}, WEEKDAYS[day]), h('label', { class: 'check' }, works, 'Atende'), h('div', {}, times, off)) };
  });
  const syncAll = () => rows.forEach(r => r.sync());
  follow.addEventListener('change', syncAll);
  syncAll();
  return {
    el: h('div', { class: 'stack', style: { gap: '0.6rem' } },
      h('label', { class: 'check' }, follow, 'Segue o horário da barbearia (com o mesmo almoço)'),
      h('div', { class: 'sched' }, rows.map(r => r.el))),
    value: () => {
      if (follow.checked) return null;
      const out = Array(7).fill(null);
      for (const r of rows) {
        if (!r.works.checked) continue;
        out[r.day] = { start: r.start.value, end: r.end.value, ...(r.bStart.value && r.bEnd.value ? { breakStart: r.bStart.value, breakEnd: r.bEnd.value } : {}) };
      }
      return out;
    },
  };
}

function barberForm(barber, done) {
  const isNew = !barber;
  const b = barber || { id: '', name: '', title: '', bio: '', photo: '', color: COLORS[(state.catalog?.barbers.length || 0) % COLORS.length], schedule: null, skipServices: [], prices: {}, commissionPercent: 0, active: true, order: 1000 };
  let color = b.color;
  const f = {
    name: input({ value: b.name, maxlength: 40 }),
    id: input({ value: b.id, maxlength: 40, disabled: !isNew, placeholder: 'gerado pelo nome' }),
    title: input({ value: b.title, maxlength: 60, placeholder: 'ex.: Degradê e navalha' }),
    bio: textarea(b.bio, { maxlength: 300 }),
    photo: input({ value: b.photo, maxlength: 120, placeholder: 'ex.: renan.webp (opcional)' }),
    commission: input({ value: b.commissionPercent, type: 'number', min: 0, max: 100, step: 1 }),
    order: input({ value: b.order, type: 'number', step: 1 }),
    active: h('input', { type: 'checkbox', checked: b.active }),
  };
  if (isNew) f.name.addEventListener('input', () => { f.id.value = slugify(f.name.value); });
  const swatches = h('div', { class: 'swatches' });
  const drawSwatches = () => swatches.replaceChildren(...COLORS.map(c => h('button', { type: 'button', class: `swatch ${c === color ? 'is-active' : ''}`, style: { '--c': c }, title: c, onclick: () => { color = c; drawSwatches(); } })));
  drawSwatches();
  const schedule = scheduleEditor(b.schedule);
  const services = (state.catalog?.services || []).filter(s => s.active);
  const priceRows = services.map(s => {
    const does = h('input', { type: 'checkbox', checked: !b.skipServices.includes(s.id) });
    const own = input({ value: Number.isFinite(b.prices[s.id]) ? moneyInput(b.prices[s.id]) : '', money: true, placeholder: moneyInput(s.price), inputmode: 'decimal' });
    const row = h('label', { class: 'price-row' }, does, h('span', {}, s.name), own, h('small', {}, `padrão ${money(s.price)}`));
    const sync = () => { row.classList.toggle('is-off', !does.checked); own.disabled = !does.checked; };
    does.addEventListener('change', sync);
    sync();
    return { s, does, own, el: row };
  });

  modal({
    title: isNew ? 'Novo barbeiro' : b.name,
    icon: isNew ? 'userPlus' : 'pencil',
    wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'form-grid' },
        field('Nome', f.name), field('Especialidade (aparece no site)', f.title),
        h('div', { class: 'span-2' }, field('Sobre (opcional)', f.bio)),
        field('Foto (arquivo em site/public/images/barbeiros/)', f.photo), field('Comissão (%)', f.commission, 'Usada no Financeiro para estimar o valor a pagar'),
        field('Cor na agenda', swatches), field('Ordem', f.order),
        field('Código interno', f.id, isNew ? 'Letras minúsculas, números e _' : 'Não pode ser alterado'),
        h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '0.6rem' } }, f.active, 'Atendendo (aparece no site e na agenda)')),
      h('div', {}, h('h3', { style: { fontSize: '14px', margin: '0.4rem 0 0.6rem', fontFamily: 'var(--font)' } }, 'Jornada da semana'), schedule.el),
      h('div', {}, h('h3', { style: { fontSize: '14px', margin: '0.4rem 0 0.3rem', fontFamily: 'var(--font)' } }, 'Serviços que faz e preço próprio'),
        h('p', { class: 'hint', style: { margin: '0 0 0.6rem' } }, 'Desmarque o que ele não faz. Preencha o valor só onde ele cobra diferente do padrão.'),
        h('div', { class: 'price-list' }, priceRows.map(r => r.el)))),
    actions: [
      !isNew ? {
        label: 'Excluir', kind: 'danger', icon: 'trash', left: true,
        onClick: async () => {
          if (!(await confirmDialog(`Excluir ${b.name}? Quem tem agendamentos registrados não pode ser excluído: desative em vez disso.`, { danger: true, confirmLabel: 'Excluir', title: 'Excluir barbeiro' }))) return false;
          setCatalog(await del(`/api/admin/catalog/barbers/${b.id}`));
          toast('Barbeiro excluído');
          done();
        },
      } : null,
      { label: 'Cancelar' },
      {
        label: 'Salvar', kind: 'primary', icon: 'check', submit: true,
        onClick: async () => {
          const prices = {};
          for (const r of priceRows) {
            if (!r.does.checked || !r.own.value.trim()) continue;
            const v = parseMoney(r.own.value);
            if (!(v >= 0)) throw new Error(`Preço inválido em ${r.s.name}`);
            if (v !== r.s.price) prices[r.s.id] = v;
          }
          const body = {
            name: f.name.value, title: f.title.value, bio: f.bio.value, photo: f.photo.value, color, commissionPercent: Number(f.commission.value) || 0,
            order: Number(f.order.value), active: f.active.checked, schedule: schedule.value(),
            skipServices: priceRows.filter(r => !r.does.checked).map(r => r.s.id), prices,
          };
          setCatalog(isNew ? await post('/api/admin/catalog/barbers', { id: f.id.value, ...body }) : await patch(`/api/admin/catalog/barbers/${b.id}`, body));
          toast(isNew ? 'Barbeiro cadastrado' : 'Barbeiro atualizado');
          done();
        },
      },
    ].filter(Boolean),
  });
}

function scheduleSummary(b) {
  if (!b.schedule) return 'Horário da barbearia';
  const days = ORDER.filter(d => b.schedule[d]).map(d => WEEKDAYS[d].slice(0, 3).toLowerCase());
  return days.length ? `Atende ${days.join(', ')}` : 'Sem dias de atendimento';
}

export default {
  id: 'servicos',
  label: 'Serviços',
  title: 'Serviços e barbeiros',
  subtitle: 'Preços, duração, jornada e serviços de cada barbeiro. Tudo muda no site na hora.',
  icon: 'scissors',
  group: 'Barbearia',
  permission: 'agenda.view',
  render(container, { actions }) {
    const editable = can('catalog.edit');
    let tab = 'services';
    let filter = '';
    let category = 'all';
    const body = h('div');
    const tabs = h('div', { class: 'tabs' });
    const chips = h('div', { class: 'chips', style: { flexWrap: 'wrap' } });
    const search = searchInput({ placeholder: 'Buscar serviço…', oninput: () => { filter = search.input.value.toLowerCase(); draw(); } });
    search.style.width = '240px';
    container.append(h('div', { class: 'toolbar' }, tabs, chips, h('div', { class: 'spacer' }), search), body);
    if (editable) {
      actions.append(btn('Novo', { icon: 'plus', kind: 'primary', size: 'sm', onclick: () => (tab === 'services' ? serviceForm(null, draw) : barberForm(null, draw)) }));
    }

    async function setFlag(resource, item, changes, label) {
      try {
        setCatalog(await patch(`/api/admin/catalog/${resource}/${item.id}`, changes));
        toast(label);
      } catch (error) {
        toast(error.message, 'error');
      }
      draw();
    }

    function drawServices() {
      const catalog = state.catalog;
      const list = catalog.services.filter(s => (!filter || s.name.toLowerCase().includes(filter)) && (category === 'all' || s.category === category));
      const groups = CATEGORIES.filter(([cat]) => list.some(s => s.category === cat));
      const special = (s) => catalog.barbers.filter(b => b.active && Number.isFinite(b.prices[s.id])).map(b => `${b.name} ${money(b.prices[s.id])}`);
      body.replaceChildren(h('div', { class: 'card card--flush' }, groups.length ? groups.map(([cat, label]) => {
        const items = list.filter(s => s.category === cat);
        return [h('h3', { class: 'cat-title' }, label, h('span', { class: 'pill' }, String(items.length))), h('table', { class: 'table table--menu' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Serviço'), h('th', { class: 'right' }, 'Preço'), h('th', {}, 'Duração'), h('th', {}, 'No site'), h('th', {}))),
          h('tbody', {}, items.map(s => h('tr', { class: s.active ? '' : 'is-off' },
            h('td', {}, h('div', { class: 'product-name' }, s.name, s.badge ? h('span', { class: 'pill pill--primary' }, s.badge) : ''),
              h('div', { class: 'product-desc' }, [s.desc, special(s).length ? `Preço próprio: ${special(s).join(', ')}` : ''].filter(Boolean).join(' • '))),
            h('td', { class: 'right num' }, h('span', { class: 'price' }, `${s.priceFrom ? 'a partir de ' : ''}${money(s.price)}`)),
            h('td', { class: 'num' }, h('span', { class: 'pill' }, icon('clock'), duration(s.duration))),
            h('td', {}, toggle(s.active, (v) => setFlag('services', s, { active: v }, v ? `${s.name} voltou ao site` : `${s.name} saiu do site`), { disabled: !editable })),
            h('td', { class: 'right' }, editable ? btn('', { icon: 'pencil', kind: 'ghost', size: 'sm', title: 'Editar', onclick: () => serviceForm(s, draw) }) : '')))))];
      }) : emptyState('Nenhum serviço encontrado', 'Tente outra busca ou categoria.', 'search')));
    }

    function drawBarbers() {
      const catalog = state.catalog;
      body.replaceChildren(catalog.barbers.length ? h('div', { class: 'barber-cards' }, catalog.barbers.map(b => {
        const skips = catalog.services.filter(s => b.skipServices.includes(s.id)).map(s => s.name);
        const own = Object.keys(b.prices).length;
        return h('div', { class: `barber-card ${b.active ? '' : 'is-off'}` },
          h('div', { class: 'barber-card__top' }, barberAvatar(b, 46),
            h('div', {}, h('h3', {}, b.name), h('p', {}, b.title || 'Barbeiro')),
            h('div', { class: 'row' },
              toggle(b.active, (v) => setFlag('barbers', b, { active: v }, v ? `${b.name} voltou a atender` : `${b.name} saiu da agenda e do site`), { disabled: !editable }),
              editable ? btn('', { icon: 'pencil', kind: 'ghost', size: 'sm', title: 'Editar', onclick: () => barberForm(b, draw) }) : null)),
          h('dl', {},
            h('dt', {}, 'Jornada'), h('dd', {}, scheduleSummary(b)),
            h('dt', {}, 'Serviços'), h('dd', {}, skips.length ? `Não faz: ${skips.join(', ')}` : 'Todos'),
            h('dt', {}, 'Preço próprio'), h('dd', {}, own ? `${own} serviço${own === 1 ? '' : 's'}` : 'Não'),
            h('dt', {}, 'Comissão'), h('dd', {}, `${b.commissionPercent}%`)));
      })) : h('div', { class: 'card' }, emptyState('Nenhum barbeiro cadastrado', 'Use o botão "Novo".', 'users')));
    }

    function draw() {
      const catalog = state.catalog;
      tabs.replaceChildren(...[['services', 'Serviços', catalog.services.length, 'scissors'], ['barbers', 'Barbeiros', catalog.barbers.length, 'users']].map(([id, label, n, i]) =>
        h('button', { class: tab === id ? 'is-active' : '', onclick: () => { tab = id; draw(); } }, icon(i, { size: 15 }), label, h('span', { class: 'count' }, String(n)))));
      chips.hidden = search.hidden = tab !== 'services';
      chips.replaceChildren(...[['all', 'Todos'], ...CATEGORIES.filter(([c]) => catalog.services.some(s => s.category === c))].map(([id, label]) =>
        h('button', { class: `chip ${category === id ? 'is-active' : ''}`, onclick: () => { category = id; draw(); } }, label)));
      if (tab === 'services') drawServices();
      else drawBarbers();
    }

    body.append(h('div', { class: 'card' }, skeleton(8)));
    loadCatalog({ force: true }).then(draw)
      .catch(err => body.replaceChildren(h('div', { class: 'card' }, emptyState('Não foi possível carregar', err.message, 'wifiOff'))));
  },
};
