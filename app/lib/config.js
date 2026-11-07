// Configurações deste computador (servidor e avisos), em %APPDATA%/Hanoff Gestão/config.json
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export const DEFAULTS = {
  serverUrl: 'https://barbearia-hanoff.vercel.app', // trocar em Ajustes quando o domínio próprio for ligado
  sound: true,       // toca um aviso quando chega agendamento pelo site
  notifyAll: true,   // avisa também agendamentos para outros dias (não só para hoje)
};

const file = () => path.join(app.getPath('userData'), 'config.json');

export function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // http só para testes locais; em produção a API exige https
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  const clean = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, config[k] ?? DEFAULTS[k]]));
  clean.sound = Boolean(clean.sound);
  clean.notifyAll = Boolean(clean.notifyAll);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(clean, null, 2));
  return clean;
}
