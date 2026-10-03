// Prueba de integracion: levanta el servidor real y cobra un pedido por HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-cashier-api-'));
const configPath = path.join(dir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  business: { name: 'BINGO API' },
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
      await fetch(`${base}/api/bootstrap`);
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

async function call(path, options) {
  const response = await fetch(base + path, {
    ...options,
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('entrega el catalogo inicial y la configuracion publica', async () => {
  const { body } = await call('/api/bootstrap');
  assert.equal(body.ok, true);
  assert.equal(body.business.name, 'BINGO API');
  assert.ok(body.products.length > 0);
  assert.ok(body.stations.length > 0);
  assert.ok(body.paymentMethods.some((method) => method.key === 'efectivo'));
});

test('cobra un pedido e imprime ticket de venta y tickets de retiro', async () => {
  const { body: bootstrap } = await call('/api/bootstrap');
  const cocina = bootstrap.stations[0];
  const bar = bootstrap.stations[1];
  const productoCocina = bootstrap.products.find((product) => product.stationId === cocina.id);
  const productoBar = bootstrap.products.find((product) => product.stationId === bar.id);

  const { status, body } = await call('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      items: [{ productId: productoCocina.id, qty: 2 }, { productId: productoBar.id, qty: 1 }],
      paymentMethod: 'efectivo',
      amountPaid: 20000,
      cashier: 'Caja test',
    }),
  });

  assert.equal(status, 200);
  assert.equal(body.order.total, productoCocina.price * 2 + productoBar.price);
  assert.equal(body.print.ok, true);
  assert.deepEqual(body.print.printed.map((doc) => doc.kind), ['receipt', 'station', 'station']);
  assert.equal(body.order.printCount, 1);

  // los bytes ESC/POS llegaron al "papel"
  const spool = fs.readFileSync(path.join(dir, 'spool.bin'));
  assert.ok(spool.length > 100);
  assert.ok(spool.includes(Buffer.from('BINGO API')));
  assert.ok(spool.includes(Buffer.from('Retira en: ')));
});

test('el cierre suma lo cobrado', async () => {
  const { body } = await call('/api/report');
  assert.equal(body.report.ordersCount, 1);
  assert.ok(body.report.total > 0);
  assert.equal(body.report.byStation.length, 2);
});

test('valida las peticiones incorrectas', async () => {
  const vacio = await call('/api/orders', { method: 'POST', body: JSON.stringify({ items: [] }) });
  assert.equal(vacio.status, 400);
  assert.equal(vacio.body.ok, false);

  const inexistente = await call('/api/orders/2000-01-01-0001');
  assert.equal(inexistente.status, 404);

  const metodo = await call('/api/report', { method: 'DELETE' });
  assert.equal(metodo.status, 405);
});

// ------------------------------------------------------------ cola del stand
// Van al final: crean pedidos y no deben alterar el cierre probado arriba.

async function stands() {
  const { body } = await call('/api/bootstrap');
  const [cocina, bar] = body.stations;
  return {
    cocina,
    bar,
    completo: body.products.find((product) => product.stationId === cocina.id),
    bebida: body.products.find((product) => product.stationId === bar.id),
  };
}

async function order(items) {
  const { body } = await call('/api/orders', { method: 'POST', body: JSON.stringify({ items, print: false }) });
  return body.order;
}

test('la cola del stand trae solo sus productos, sin anulados y en orden de llegada', async () => {
  const { cocina, bar, completo, bebida } = await stands();
  const mixto = await order([{ productId: completo.id, qty: 2 }, { productId: bebida.id, qty: 1 }]);
  const soloBar = await order([{ productId: bebida.id, qty: 1 }]);
  const anulado = await order([{ productId: completo.id, qty: 1 }]);
  await call(`/api/orders/${anulado.id}/void`, { method: 'POST', body: JSON.stringify({ reason: 'test' }) });

  const { status, body } = await call(`/api/stations/${cocina.id}/queue`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.station, { id: cocina.id, name: cocina.name });
  const ids = body.pending.map((entry) => entry.id);
  assert.ok(ids.includes(mixto.id));
  assert.ok(!ids.includes(soloBar.id), 'un pedido sin productos del stand no aparece');
  assert.ok(!ids.includes(anulado.id), 'los anulados no aparecen');

  const entry = body.pending.find((item) => item.id === mixto.id);
  assert.equal(entry.code, mixto.code);
  assert.deepEqual(entry.items, [{ name: completo.name, qty: 2, note: '' }]);
  assert.equal(entry.deliveredAt, undefined);

  const created = body.pending.map((item) => item.createdAt);
  assert.deepEqual(created, [...created].sort(), 'los pendientes van del mas antiguo al mas nuevo');
  assert.deepEqual(body.delivered, []);

  const barQueue = await call(`/api/stations/${bar.id}/queue`);
  assert.ok(barQueue.body.pending.some((item) => item.id === soloBar.id));
});

test('entregar mueve el pedido a entregados solo en ese stand y se puede deshacer', async () => {
  const { cocina, bar, completo, bebida } = await stands();
  const mixto = await order([{ productId: completo.id, qty: 1 }, { productId: bebida.id, qty: 1 }]);

  await call(`/api/orders/${mixto.id}/deliver`, { method: 'POST', body: JSON.stringify({ stationId: cocina.id, delivered: true }) });
  const cocinaQueue = (await call(`/api/stations/${cocina.id}/queue`)).body;
  assert.ok(!cocinaQueue.pending.some((item) => item.id === mixto.id));
  assert.equal(cocinaQueue.delivered[0].id, mixto.id);
  assert.match(cocinaQueue.delivered[0].deliveredAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  const barQueue = (await call(`/api/stations/${bar.id}/queue`)).body;
  assert.ok(barQueue.pending.some((item) => item.id === mixto.id), 'el bar aun no lo entrega');

  await call(`/api/orders/${mixto.id}/deliver`, { method: 'POST', body: JSON.stringify({ stationId: cocina.id, delivered: false }) });
  const again = (await call(`/api/stations/${cocina.id}/queue?limit=1`)).body;
  assert.ok(again.pending.some((item) => item.id === mixto.id));
  assert.ok(again.delivered.length <= 1);
});

test('la cola "none" junta los productos sin stand', async () => {
  const { completo } = await stands();
  const { body: created } = await call('/api/products', {
    method: 'POST',
    body: JSON.stringify({ name: 'Rifa', price: 1000, stationId: null }),
  });
  const pedido = await order([{ productId: created.product.id, qty: 3 }, { productId: completo.id, qty: 1 }]);

  const { status, body } = await call('/api/stations/none/queue');
  assert.equal(status, 200);
  assert.deepEqual(body.station, { id: null, name: 'RETIRO' });
  const entry = body.pending.find((item) => item.id === pedido.id);
  assert.deepEqual(entry.items, [{ name: 'Rifa', qty: 3, note: '' }]);

  await call(`/api/orders/${pedido.id}/deliver`, { method: 'POST', body: JSON.stringify({ stationId: null, delivered: true }) });
  const after = (await call('/api/stations/none/queue')).body;
  assert.equal(after.delivered[0].id, pedido.id);
});

test('un stand inexistente responde 404', async () => {
  const missing = await call('/api/stations/9999/queue');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.ok, false);

  const invalid = await call('/api/stations/abc/queue');
  assert.equal(invalid.status, 404);
});
