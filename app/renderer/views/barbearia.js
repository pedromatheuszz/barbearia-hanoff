// Barbearia: agenda online (pausa), dados de contato, horário de funcionamento e regras do agendamento pelo site
import { h, icon, btn, card, toast, field, input, select, skeleton, emptyState, WEEKDAYS } from '../ui.js';
import { patch } from '../api.js';
import { can, state, refreshStore, togglePause, loadCatalog } from '../app.js';

const ORDER = [1, 2, 3, 4, 5, 6, 0];
const INTERVALS = [10, 15, 20, 30, 45, 60];

export default {
  id: 'barbearia',
  label: 'Barbearia',
  subtitle: 'Agenda online, contatos, horário de funcionamento e regras do agendamento pelo site.',
  icon: 'store',
  group: 'Barbearia',
  permission: 'agenda.view',
  render(container) {
    const editable = can('store.edit');

    async function load() {
      if (!container.childElementCount) container.append(h('div', { class: 'grid-2' }, h('div', { class: 'card' }, skeleton(6)), h('div', { class: 'card' }, skeleton(8))));
      try {
        await refreshStore();
        if (!state.store) throw new Error('Sem conexão com o servidor');
        draw();
      } catch (error) {
        container.replaceChildren(h('div', { class: 'card' }, emptyState('Não foi possível carregar', error.message, 'wifiOff')));
      }
    }

    const save = async (values, message) => {
      try {
        await patch('/api/admin/store', values);
        toast(message);
        loadCatalog({ force: true }).catch(() => {});
        load();
      } catch (error) {
        toast(error.message, 'error');
      }
    };

    function draw() {
      const { settings, status } = state.store;
      const tone = settings.paused ? 'warn' : 'ok';
      const missing = [!settings.whatsappPhone && 'WhatsApp', !settings.address && 'endereço'].filter(Boolean);

      // --- Agenda online ---
      const situation = card({ title: 'Agenda online', subtitle: 'Com a agenda pausada, o site não aceita agendamentos. A equipe continua agendando pelo app.', icon: 'globe' },
        h('div', { class: `banner ${tone === 'ok' ? 'banner--ok' : ''}`, style: { margin: 0 } },
          h('span', { class: `dot dot--${tone} ${tone === 'ok' ? 'dot--live' : ''}` }),
          settings.paused ? `Pausada${settings.pauseMessage ? ` • ${settings.pauseMessage}` : ''}` : `Aceitando agendamentos • ${status.label}`,
          can('store.pause') ? btn(settings.paused ? 'Retomar' : 'Pausar', { icon: settings.paused ? 'play' : 'pause', kind: settings.paused ? 'ok' : 'primary', size: 'sm', onclick: () => togglePause().then(load).catch(e => toast(e.message, 'error')) }) : null));

      // --- Dados ---
      const f = {
        storeName: input({ value: settings.storeName, disabled: !editable }),
        whatsappPhone: input({ value: settings.whatsappPhone, disabled: !editable, placeholder: '5547999999999' }),
        address: input({ value: settings.address, disabled: !editable, maxlength: 120, placeholder: 'R. Exemplo, 123 — Bairro' }),
        city: input({ value: settings.city, disabled: !editable, maxlength: 60, placeholder: 'Joinville/SC' }),
        instagram: input({ value: settings.instagram ? `@${settings.instagram}` : '', disabled: !editable, placeholder: '@perfil' }),
        mapsUrl: input({ value: settings.mapsUrl, disabled: !editable, placeholder: 'https://maps.app.goo.gl/...' }),
      };
      const info = card({
        tag: 'form', title: 'Dados da barbearia', subtitle: 'Aparecem no site, no link do cliente e na mensagem de confirmação.', icon: 'info',
        onsubmit: (e) => {
          e.preventDefault();
          save({
            storeName: f.storeName.value, whatsappPhone: f.whatsappPhone.value, address: f.address.value, city: f.city.value,
            instagram: f.instagram.value, mapsUrl: f.mapsUrl.value,
          }, 'Dados da barbearia salvos');
        },
      },
      h('div', { class: 'stack' },
        missing.length ? h('div', { class: 'banner', style: { margin: 0 } }, icon('alert'), `Falta cadastrar: ${missing.join(' e ')}. Sem isso o site esconde esses botões.`) : null,
        h('div', { class: 'form-grid' },
          field('Nome', f.storeName), field('WhatsApp', f.whatsappPhone, '55 + DDD + número'),
          field('Endereço', f.address), field('Cidade', f.city),
          field('Instagram', f.instagram), field('Link do mapa (Google Maps)', f.mapsUrl, 'Botão "Como chegar" do site')),
        editable ? h('div', {}, btn('Salvar dados', { icon: 'check', kind: 'primary', type: 'submit' })) : null));

      // --- Horários (com almoço) ---
      const rows = ORDER.map(day => {
        const hrs = settings.hours[day];
        const open = h('input', { type: 'checkbox', checked: !!hrs, disabled: !editable });
        const from = input({ type: 'time', value: hrs?.open || '09:00', step: 300, disabled: !editable || !hrs });
        const until = input({ type: 'time', value: hrs?.close || '20:00', step: 300, disabled: !editable || !hrs });
        const bFrom = input({ type: 'time', value: hrs?.breakStart || '', step: 300, disabled: !editable || !hrs });
        const bUntil = input({ type: 'time', value: hrs?.breakEnd || '', step: 300, disabled: !editable || !hrs });
        const closed = h('span', { class: 'faint', hidden: !!hrs }, 'Fechado');
        const times = h('div', { class: 'sched__times', hidden: !hrs },
          h('span', { class: 'sched__group' }, from, h('small', {}, 'às'), until),
          h('span', { class: 'sched__group' }, h('small', {}, 'almoço'), bFrom, h('small', {}, 'às'), bUntil));
        open.addEventListener('change', () => {
          [from, until, bFrom, bUntil].forEach(i => { i.disabled = !open.checked; });
          times.hidden = !open.checked;
          closed.hidden = open.checked;
        });
        return { day, open, from, until, bFrom, bUntil, el: h('div', { class: 'sched__row' }, h('strong', {}, WEEKDAYS[day]), h('label', { class: 'check' }, open, 'Abre'), h('div', {}, times, closed)) };
      });
      const hours = card({
        tag: 'form', title: 'Horário de funcionamento', subtitle: 'Horário de Brasília. O almoço é opcional: deixe em branco se não fecha.', icon: 'clock',
        onsubmit: (e) => {
          e.preventDefault();
          const grid = Array(7).fill(null);
          rows.forEach(r => {
            if (!r.open.checked) return;
            grid[r.day] = { open: r.from.value, close: r.until.value, ...(r.bFrom.value && r.bUntil.value ? { breakStart: r.bFrom.value, breakEnd: r.bUntil.value } : {}) };
          });
          save({ hours: grid }, 'Horários salvos');
        },
      },
      h('div', { class: 'sched' }, rows.map(r => r.el)),
      editable ? h('div', { style: { marginTop: '0.9rem' } }, btn('Salvar horários', { icon: 'check', kind: 'primary', type: 'submit' })) : null);

      // --- Regras do agendamento online ---
      const r = {
        slotInterval: select(INTERVALS.map(n => [n, `De ${n} em ${n} minutos`]), settings.slotInterval, { disabled: !editable }),
        minNotice: select([[0, 'Sem antecedência'], [15, '15 minutos'], [30, '30 minutos'], [60, '1 hora'], [120, '2 horas'], [180, '3 horas'], [1440, '1 dia']], settings.minNoticeMinutes, { disabled: !editable }),
        maxDays: input({ type: 'number', min: 1, max: 120, value: settings.maxDaysAhead, disabled: !editable }),
        cancelHours: input({ type: 'number', min: 0, max: 72, value: settings.cancelHours, disabled: !editable }),
      };
      const rules = card({
        tag: 'form', title: 'Regras do agendamento pelo site', subtitle: 'Valem só para o site; a equipe agenda sem essas limitações.', icon: 'calendar',
        onsubmit: (e) => {
          e.preventDefault();
          save({ slotInterval: Number(r.slotInterval.value), minNoticeMinutes: Number(r.minNotice.value), maxDaysAhead: Number(r.maxDays.value), cancelHours: Number(r.cancelHours.value) }, 'Regras da agenda salvas');
        },
      },
      h('div', { class: 'form-grid' },
        field('Horários oferecidos', r.slotInterval, 'Ex.: 09:00, 09:15, 09:30…'),
        field('Antecedência mínima', r.minNotice, 'Para agendar no mesmo dia'),
        field('Agenda aberta até (dias)', r.maxDays, 'Quantos dias à frente o cliente vê'),
        field('Cancelar pelo link até (horas antes)', r.cancelHours, '0 = até a hora marcada')),
      editable ? h('div', { style: { marginTop: '0.9rem' } }, btn('Salvar regras', { icon: 'check', kind: 'primary', type: 'submit' })) : null);

      container.replaceChildren(
        editable ? '' : h('div', { class: 'banner banner--info' }, icon('lock'), 'Você pode pausar a agenda online, mas só o dono altera dados, horários e regras.'),
        h('div', { class: 'grid-2' }, h('div', { class: 'stack' }, situation, info, rules), h('div', { class: 'stack' }, hours)));
    }

    load();
  },
};
