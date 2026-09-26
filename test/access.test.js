// Acceso por rol con la caja abierta a internet: levanta el servidor real con codigos.
// Los pedidos por el tunel llegan desde localhost con la IP real en cf-connecting-ip;
// las pruebas lo simulan con ese encabezado.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-cashier-access-'));
const configPath = path.join(dir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  business: { name: 'BINGO REMOTO' },
  adminPin: '4321',
  access: { cashierCode: 'CAJA22', standCode: 'STAND3' },
  printer: { enabled: true, mode: 'file', file: path.join(dir, 'spool.bin'), charsPerLine: 32 },
}));

const port = 8000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
let server;

test.before(async () => {
  server = spawn(process.execPath, ['server.js', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, POCKET_CASHIER_DATA: path.join(dir, 'data'), POCKET_CASHIER_CONFIG: configPath },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`${base}/api/access`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('el servidor no respondio');
});

test.after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `as`: codigo de acceso; `ip`: simula un celular entrando por el tunel. */
async function call(route, { method = 'GET', body, as, pin, ip = '200.1.1.1' } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (as) headers['X-Access-Code'] = as;
  if (pin) headers['X-Admin-Pin'] = pin;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}

test('sin codigo no se ve nada y la pantalla sabe que debe pedirlo', async () => {
  const { status, body } = await call('/api/bootstrap');
  assert.equal(status, 401);
  assert.equal(body.auth, 'code');
  const access = await call('/api/access');
  assert.equal(access.body.required, true);
  assert.equal(access.body.role, null);
});

test('el codigo de stands ve su cola y entrega, pero no cobra', async () => {
  const boot = await call('/api/bootstrap', { as: 'stand3' }); // minusculas tambien sirven
  assert.equal(boot.status, 200);
  assert.equal(boot.body.role, 'stand');
  const station = boot.body.stations[0];
  assert.equal((await call(`/api/stations/${station.id}/queue`, { as: 'STAND3' })).status, 200);

  const product = boot.body.products.find((p) => p.stationId === station.id);
  const sale = await call('/api/orders', { method: 'POST', as: 'STAND3', body: { items: [{ productId: product.id, qty: 1 }] } });
  assert.equal(sale.status, 403);
  assert.equal((await call('/api/orders', { as: 'STAND3' })).status, 403);

  const order = await call('/api/orders', { method: 'POST', as: 'CAJA22', body: { items: [{ productId: product.id, qty: 1 }] } });
  assert.equal(order.status, 200);
  const delivered = await call(`/api/orders/${order.body.order.id}/deliver`, { method: 'POST', as: 'STAND3', body: { stationId: station.id } });
  assert.equal(delivered.status, 200);
});

test('una caja cobra, pero Ajustes y anular piden el PIN', async () => {
  const settings = await call('/api/settings', { as: 'CAJA22' });
  assert.equal(settings.status, 401);
  assert.equal(settings.body.auth, 'pin');
  const withPin = await call('/api/settings', { as: 'CAJA22', pin: '4321' });
  assert.equal(withPin.status, 200);
  // el PIN solo no alcanza: sin codigo de caja no hay acceso
  assert.equal((await call('/api/settings', { pin: '4321' })).status, 401);
});

test('el PC de la caja entra como administrador sin codigo', async () => {
  const { status, body } = await call('/api/bootstrap', { ip: null });
  assert.equal(status, 200);
  assert.equal(body.role, 'admin');
  assert.equal((await call('/api/settings', { ip: null })).status, 200);
});

test('no se aceptan codigos iguales ni muy cortos', async () => {
  const same = await call('/api/settings', { method: 'PUT', ip: null, body: { access: { cashierCode: 'ABCD', standCode: 'abcd' } } });
  assert.equal(same.status, 400);
  const short = await call('/api/settings', { method: 'PUT', ip: null, body: { access: { cashierCode: 'AB', standCode: '' } } });
  assert.equal(short.status, 400);
});

test('tras 10 codigos equivocados esa IP queda bloqueada, aun con el codigo bueno', async () => {
  const ip = '200.9.9.9';
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await call('/api/bootstrap', { as: `MALO${attempt}`, ip })).status, 401);
  }
  assert.equal((await call('/api/bootstrap', { as: 'CAJA22', ip })).status, 429);
  // otra IP no se ve afectada
  assert.equal((await call('/api/bootstrap', { as: 'CAJA22', ip: '200.8.8.8' })).status, 200);
});
