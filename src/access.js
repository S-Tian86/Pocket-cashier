// Acceso por rol cuando la caja se abre a internet (tunel). Sin codigos
// configurados todo funciona como en la red local de siempre.
//   stand  -> ve la cola de su stand y marca entregas
//   caja   -> ademas cobra, reimprime y ve pedidos y cierre
//   admin  -> ademas Ajustes y anulaciones (caja + PIN, o el propio PC)
import crypto from 'node:crypto';

import * as config from './config.js';

export const LEVELS = { stand: 1, cashier: 2, admin: 3 };

// Sin letras ni numeros que se confunden al dictarlos o leerlos del papel (O/0, I/1/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

/** Los codigos se escriben en celulares: mayusculas/minusculas, espacios y guiones dan igual. */
export function normalizeCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function accessCodes() {
  const access = config.get('access', {}) || {};
  return { cashier: normalizeCode(access.cashierCode), stand: normalizeCode(access.standCode) };
}

export function accessEnabled() {
  const codes = accessCodes();
  return Boolean(codes.cashier || codes.stand);
}

function sameSecret(a, b) {
  if (!a || !b) return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

/**
 * Pedido hecho en el mismo PC y no a traves del tunel. cloudflared y ngrok se
 * conectan desde localhost, pero agregan la IP real del visitante en estos
 * encabezados: sin ellos, es alguien sentado frente al PC de la impresora.
 */
export function isLocalPc(req) {
  const address = req.socket?.remoteAddress || '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  return loopback && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}

export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim();
}

/**
 * Rol de quien hace el pedido, o null si no tiene acceso. `failed` indica que
 * mando un codigo o PIN equivocado (cuenta para el bloqueo por intentos).
 */
export function resolveRole(req) {
  const pin = String(config.get('adminPin', '') || '');
  const sentPin = String(req.headers['x-admin-pin'] || '');
  const pinOk = Boolean(pin) && sameSecret(sentPin, pin);
  const pinFailed = Boolean(sentPin) && Boolean(pin) && !pinOk;

  if (!accessEnabled()) {
    // red local de siempre: todos cobran; Ajustes pide el PIN solo si hay uno
    return { role: !pin || pinOk ? 'admin' : 'cashier', failed: pinFailed };
  }
  if (isLocalPc(req)) return { role: 'admin', failed: false };

  const codes = accessCodes();
  const sent = normalizeCode(req.headers['x-access-code']);
  let role = null;
  if (sameSecret(sent, codes.cashier)) role = 'cashier';
  else if (sameSecret(sent, codes.stand)) role = 'stand';
  // sin PIN configurado nadie es admin desde fuera: Ajustes queda solo en el PC
  if (role === 'cashier' && pinOk) role = 'admin';
  return { role, failed: (Boolean(sent) && !role) || pinFailed };
}

// ---------------------------------------------------------------- intentos

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // ip -> [instantes de los intentos fallidos]

function recentFailures(ip, now) {
  const list = (failures.get(ip) || []).filter((at) => now - at < WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

/** Un codigo de 6 caracteres se adivinaria probando; tras 10 fallos la IP espera 10 minutos. */
export function isBlocked(ip, now = Date.now()) {
  return recentFailures(ip, now).length >= MAX_FAILURES;
}

export function registerFailure(ip, now = Date.now()) {
  const list = recentFailures(ip, now);
  list.push(now);
  failures.set(ip, list);
}

export function resetFailures() {
  failures.clear();
}
