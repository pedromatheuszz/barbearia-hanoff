// Ajustes deste computador: avisos de agendamento, aparência, servidor e inicialização
import { h, icon, btn, card, toast, field, input, toggle, skeleton } from '../ui.js';
import { state, ding, setTheme, reloadConfig, logout } from '../app.js';

const settingRow = (title, text, control) => h('div', { class: 'row', style: { flexWrap: 'nowrap', padding: '0.7rem 0', borderTop: '1px solid var(--border)' } },
  h('div', { style: { flex: 1 } }, h('strong', {}, title), text ? h('div', { class: 'faint', style: { fontSize: '12.5px' } }, text) : null), control);

function themeOption(value, label, iconName, current) {
  return h('button', {
    class: `chip ${current === value ? 'is-active' : ''}`,
    onclick: (e) => {
      setTheme(value);
      e.currentTarget.parentElement.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-active', c === e.currentTarget));
    },
  }, icon(iconName), label);
}

export default {
  id: 'ajustes',
  label: 'Ajustes',
  subtitle: 'Configurações deste computador: avisos, aparência e servidor.',
  icon: 'settings',
  group: 'Sistema',
  render(container) {
    async function save(changes, message = 'Ajuste salvo') {
      const res = await window.gestao.setConfig(changes);
      if (!res.ok) return toast(res.error, 'error');
      await reloadConfig();
      toast(message);
      return true;
    }

    async function draw() {
      const config = await reloadConfig();
      const theme = document.documentElement.dataset.theme;
      const server = input({ value: config.serverUrl });

      container.replaceChildren(h('div', { class: 'grid-2' },
        h('div', { class: 'stack' },
          card({ title: 'Aviso de agendamento novo', subtitle: 'Som, notificação do Windows e barra de tarefas piscando quando alguém agenda pelo site.', icon: 'bell' },
            settingRow('Tocar som', 'Uma campainha curta a cada agendamento do site', h('div', { class: 'row', style: { flexWrap: 'nowrap' } },
              btn('Testar', { icon: 'volume', size: 'sm', kind: 'ghost', onclick: () => ding({ force: true }) }), toggle(config.sound, (v) => save({ sound: v })))),
            settingRow('Avisar agendamentos de outros dias', 'Desligado: só avisa quando o horário marcado é para hoje', toggle(config.notifyAll, (v) => save({ notifyAll: v }))),
            settingRow('Abrir com o Windows', 'O app já abre quando o computador liga', toggle(config.openAtLogin, (v) => save({ openAtLogin: v })))),
          card({ title: 'Aparência', subtitle: 'O tema escuro combina com o emblema e cansa menos a vista.', icon: theme === 'light' ? 'sun' : 'moon' },
            h('div', { class: 'chips' }, themeOption('dark', 'Escuro', 'moon', theme), themeOption('light', 'Claro', 'sun', theme)))),
        h('div', { class: 'stack' },
          card({
            tag: 'form', title: 'Servidor', subtitle: 'Endereço do site com a API. Trocar pede login de novo.', icon: 'server',
            onsubmit: async (e) => {
              e.preventDefault();
              if (server.value.trim().replace(/\/$/, '') === config.serverUrl) return;
              if (await save({ serverUrl: server.value }, 'Servidor alterado. Entre novamente.')) logout();
            },
          },
          h('div', { class: 'stack' }, field('Endereço do site', server), h('div', {}, btn('Salvar endereço', { icon: 'check', type: 'submit' })))),
          card({ title: 'Sobre', icon: 'info' },
            h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'center' } },
              h('img', { src: 'assets/emblema.png', alt: '', style: { width: '52px', height: '52px', borderRadius: '50%' } }),
              h('div', { style: { flex: 1 } }, h('strong', {}, `Hanoff Gestão ${config.version}`),
                h('div', { class: 'faint' }, `${state.user.displayName} (${state.user.roleLabel}) • ${config.serverUrl.replace(/^https?:\/\//, '')}`)),
              btn('Sair', { icon: 'logout', kind: 'danger', size: 'sm', onclick: logout }))))));
    }

    container.append(h('div', { class: 'grid-2' }, h('div', { class: 'card' }, skeleton(5)), h('div', { class: 'card' }, skeleton(5))));
    draw();
  },
};
