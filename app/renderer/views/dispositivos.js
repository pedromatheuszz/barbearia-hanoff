// Dispositivos: computadores que usam o app e bloqueio geral (somente o login de desenvolvedor)
import { h, icon, btn, card, dateTime, toast, modal, field, input, skeleton, emptyState, confirmDialog, toggle } from '../ui.js';
import { get, patch, del } from '../api.js';
import { state } from '../app.js';

const ONLINE_MS = 3 * 60 * 1000; // visto há menos de 3 min: app aberto agora

function since(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'agora';
  if (mins < 60) return `há ${mins} min`;
  if (mins < 1440) return `há ${Math.floor(mins / 60)} h`;
  return dateTime(iso);
}

function licenseForm(license, done) {
  const msg = input({ value: license.message, maxlength: 200, placeholder: 'Ex.: Mensalidade em aberto. Fale com o suporte.' });
  modal({
    title: 'Bloquear o app',
    icon: 'lock',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Todos os usuários da barbearia saem do app na próxima atualização e não conseguem entrar até você liberar. O site e os agendamentos dos clientes continuam funcionando. Seu login de desenvolvedor continua entrando.'),
      field('Mensagem na tela de login (opcional)', msg)),
    actions: [
      { label: 'Cancelar' },
      {
        label: 'Bloquear app', kind: 'danger', icon: 'lock', submit: true,
        onClick: async () => {
          await patch('/api/admin/devices', { blocked: true, message: msg.value });
          toast('App bloqueado para a barbearia');
          done();
        },
      },
    ],
  });
}

export default {
  id: 'dispositivos',
  label: 'Dispositivos',
  subtitle: 'Computadores que usam o app. Bloqueie ou libere um computador ou o app inteiro.',
  icon: 'server',
  group: 'Sistema',
  permission: 'system.devices',
  render(container, { actions }) {
    const body = h('div', {}, h('div', { class: 'card' }, skeleton(5)));
    container.append(body);
    actions.append(btn('Atualizar', { icon: 'refresh', size: 'sm', onclick: () => draw() }));

    async function setDevice(d, blocked) {
      if (blocked && d.id === state.config.deviceId) {
        toast('Este é o seu computador. Seu login de desenvolvedor continua entrando nele.', 'error');
      }
      await patch(`/api/admin/devices/${encodeURIComponent(d.id)}`, { blocked });
      toast(blocked ? `${d.name} bloqueado` : `${d.name} liberado`);
      draw();
    }

    function editNote(d) {
      const note = input({ value: d.note, maxlength: 120, placeholder: 'Ex.: Recepção, notebook do dono' });
      modal({
        title: d.name,
        icon: 'pencil',
        body: field('Apelido / observação', note, 'Só você vê. Ajuda a saber qual computador é qual.'),
        actions: [{ label: 'Cancelar' }, {
          label: 'Salvar', kind: 'primary', icon: 'check', submit: true,
          onClick: async () => { await patch(`/api/admin/devices/${encodeURIComponent(d.id)}`, { note: note.value }); draw(); },
        }],
      });
    }

    async function remove(d) {
      if (!(await confirmDialog(`Tirar "${d.name}" da lista? Se o app for aberto nele de novo, ele volta a aparecer.`, { title: 'Remover da lista', confirmLabel: 'Remover', danger: true }))) return;
      await del(`/api/admin/devices/${encodeURIComponent(d.id)}`);
      toast('Removido da lista');
      draw();
    }

    async function draw() {
      try {
        const { license, devices } = await get('/api/admin/devices');
        const online = devices.filter(d => Date.now() - Date.parse(d.lastSeen) < ONLINE_MS).length;

        const licenseCard = card({ title: 'Acesso ao app', subtitle: 'Vale para todos os computadores e usuários da barbearia', icon: 'lock' },
          h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' } },
            h('div', { class: 'stack', style: { gap: '0.3rem' } },
              license.blocked
                ? h('span', { class: 'pill pill--danger', style: { justifySelf: 'start', alignSelf: 'flex-start' } }, icon('lock'), 'App bloqueado')
                : h('span', { class: 'pill pill--ok', style: { justifySelf: 'start', alignSelf: 'flex-start' } }, icon('checkCircle'), 'App liberado'),
              license.blocked && license.message ? h('p', { class: 'muted', style: { margin: 0 } }, `Mensagem: ${license.message}`) : null,
              license.updatedAt ? h('p', { class: 'faint', style: { margin: 0 } }, `Alterado por ${license.updatedBy} em ${dateTime(license.updatedAt)}`) : null),
            license.blocked
              ? btn('Liberar app', {
                icon: 'check', kind: 'primary',
                onclick: async () => { await patch('/api/admin/devices', { blocked: false }); toast('App liberado'); draw(); },
              })
              : btn('Bloquear app', { icon: 'lock', kind: 'danger', onclick: () => licenseForm(license, draw) })),
          h('div', { class: 'row', style: { flexWrap: 'nowrap', marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border)' } },
            h('div', { style: { flex: 1 } },
              h('strong', {}, 'Exigir liberação de computadores novos'),
              h('div', { class: 'faint', style: { fontSize: '12.5px' } }, 'Ligado: um computador que abre o app pela primeira vez fica bloqueado até você liberar aqui. Também barra versões antigas do app, que não se identificam.')),
            toggle(license.approveDevices, async (value, box) => {
              try {
                await patch('/api/admin/devices', { approveDevices: value });
                toast(value ? 'Computadores novos precisam da sua liberação' : 'Computadores novos entram liberados');
                draw();
              } catch (err) {
                box.checked = !value;
                toast(err.message, 'error');
              }
            })));

        const list = devices.length ? h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Computador'), h('th', {}, 'Último usuário'), h('th', {}, 'Último acesso'), h('th', {}, 'Versão'), h('th', {}, 'Status'), h('th', {}))),
          h('tbody', {}, devices.map(d => h('tr', { class: d.blocked ? 'is-off' : '' },
            h('td', {}, h('strong', {}, d.name, d.id === state.config.deviceId ? h('span', { class: 'faint' }, ' (este)') : null),
              h('div', { class: 'faint' }, d.note || `desde ${dateTime(d.firstSeen)}`)),
            h('td', {}, d.lastUser || '—'),
            h('td', { class: 'num' }, Date.now() - Date.parse(d.lastSeen) < ONLINE_MS ? h('span', { class: 'pill pill--ok' }, 'Online') : since(d.lastSeen)),
            h('td', { class: 'num faint' }, d.appVersion ? `v${d.appVersion}` : '—'),
            h('td', {}, d.blocked ? h('span', { class: 'pill pill--danger' }, icon('ban'), 'Bloqueado') : h('span', { class: 'pill pill--ok' }, 'Liberado')),
            h('td', { class: 'right', style: { whiteSpace: 'nowrap' } },
              btn('', { icon: 'pencil', kind: 'ghost', size: 'sm', title: 'Apelido', onclick: () => editNote(d) }),
              d.blocked
                ? btn('Liberar', { icon: 'check', size: 'sm', onclick: () => setDevice(d, false).catch(e => toast(e.message, 'error')) })
                : btn('Bloquear', { icon: 'ban', kind: 'danger', size: 'sm', onclick: () => setDevice(d, true).catch(e => toast(e.message, 'error')) }),
              d.blocked ? null : btn('', { icon: 'trash', kind: 'ghost', size: 'sm', title: 'Remover da lista', onclick: () => remove(d).catch(e => toast(e.message, 'error')) }))))))
          : emptyState('Nenhum computador ainda', 'Os computadores aparecem aqui quando alguém usa o app neles.', 'server');

        body.replaceChildren(h('div', { class: 'stack' },
          licenseCard,
          card({ title: 'Computadores', subtitle: `${devices.length} no total • ${online} com o app aberto agora`, icon: 'server', flush: true }, list)));
      } catch (err) {
        body.replaceChildren(h('div', { class: 'card' }, emptyState('Não foi possível carregar', err.message, 'wifiOff')));
      }
    }
    draw();
  },
};
