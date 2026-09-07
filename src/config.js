// Carga y guardado de la configuracion (config.json en la raiz del proyecto).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// POCKET_CASHIER_CONFIG permite usar otro archivo (util para pruebas o varias cajas).
const CONFIG_PATH = process.env.POCKET_CASHIER_CONFIG
  ? path.resolve(process.env.POCKET_CASHIER_CONFIG)
  : path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

export const DEFAULTS = {
  business: {
    name: 'MI NEGOCIO',
    subtitle: '',
    footer: 'Gracias por su compra!',
    extraLine: '',
  },
  server: { host: '0.0.0.0', port: 8080 },
  businessDayStartHour: 5,
  adminPin: '',
  currency: { symbol: '$', decimals: 0, thousandsSep: '.', decimalSep: ',' },
  printer: {
    enabled: true,
    // network | device | command | file | none
    mode: 'none',
    host: '192.168.1.87',
    port: 9100,
    device: '/dev/usb/lp0',
    command: 'lp -d TICKET -o raw {file}',
    file: 'data/spool.bin',
    timeout: 6000,
    charsPerLine: 32,
    encoding: 'cp850',
    codepage: 2,
    cut: true,
    feedLines: 3,
    openDrawer: false,
    barcode: 'code39', // code39 | qr | none
  },
  tickets: {
    printReceipt: true,
    printStationTickets: true,
    receiptCopies: 1,
    stationTicketCopies: 1,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function merge(base, override) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value;
  }
  return out;
}

let cache = null;

export function load({ force = false } = {}) {
  if (cache && !force) return cache;
  let stored = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } else if (fs.existsSync(EXAMPLE_PATH)) {
      stored = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8'));
      stored.printer = { ...(stored.printer || {}), mode: 'none' };
    }
  } catch (err) {
    console.error('[config] no se pudo leer la configuracion:', err.message);
    stored = {};
  }
  cache = merge(DEFAULTS, stored);
  return cache;
}

export function save(patch) {
  const merged = merge(load(), patch);
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
  cache = merged;
  return merged;
}

export function get(dottedPath, fallback) {
  let node = load();
  for (const part of dottedPath.split('.')) {
    if (!isPlainObject(node) || !(part in node)) return fallback;
    node = node[part];
  }
  return node === undefined ? fallback : node;
}

export function configPath() {
  return CONFIG_PATH;
}
