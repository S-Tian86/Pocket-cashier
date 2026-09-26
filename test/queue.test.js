import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStationQueue } from '../src/queue.js';

// Pedidos armados a mano: la cola es una funcion pura, no necesita disco.
function order(number, { createdAt, items, status = 'paid', deliveries = {} }) {
  const code = String(number).padStart(4, '0');
  return { id: `2026-09-07-${code}`, number, code, day: '2026-09-07', createdAt, items, status, deliveries };
}

function item(productId, name, stationId, qty, note = '') {
  return { productId, name, stationId, stationName: stationId ? `S${stationId}` : 'RETIRO', qty, note, price: 1000, subtotal: 1000 * qty };
}

test('filtra por stand y descarta pedidos anulados o sin productos del stand', () => {
  const orders = [
    order(1, { createdAt: '2026-09-07 20:00:00', items: [item(1, 'Completo', 1, 2), item(2, 'Bebida', 2, 1)] }),
    order(2, { createdAt: '2026-09-07 20:01:00', items: [item(2, 'Bebida', 2, 1)] }),
    order(3, { createdAt: '2026-09-07 20:02:00', items: [item(1, 'Completo', 1, 1)], status: 'void' }),
  ];
  const { pending, delivered } = buildStationQueue(orders, 1);
  assert.deepEqual(pending, [
    { id: '2026-09-07-0001', code: '0001', createdAt: '2026-09-07 20:00:00', items: [{ name: 'Completo', qty: 2, note: '' }] },
  ]);
  assert.deepEqual(delivered, []);
});

test('suma lineas del mismo producto solo si la nota es igual', () => {
  const orders = [order(1, {
    createdAt: '2026-09-07 20:00:00',
    items: [
      item(1, 'Completo', 1, 1),
      item(1, 'Completo', 1, 2),
      item(1, 'Completo', 1, 1, 'sin mayo'),
      item(3, 'Papas', 1, 1),
    ],
  })];
  const [entry] = buildStationQueue(orders, 1).pending;
  assert.deepEqual(entry.items, [
    { name: 'Completo', qty: 3, note: '' },
    { name: 'Completo', qty: 1, note: 'sin mayo' },
    { name: 'Papas', qty: 1, note: '' },
  ]);
});

test('los pendientes salen en orden de llegada', () => {
  const orders = [
    order(3, { createdAt: '2026-09-07 20:05:00', items: [item(1, 'Completo', 1, 1)] }),
    order(1, { createdAt: '2026-09-07 20:00:00', items: [item(1, 'Completo', 1, 1)] }),
    order(2, { createdAt: '2026-09-07 20:00:00', items: [item(1, 'Completo', 1, 1)] }),
  ];
  assert.deepEqual(buildStationQueue(orders, 1).pending.map((entry) => entry.code), ['0001', '0002', '0003']);
});

test('los entregados van del ultimo entregado al primero y respetan el limite', () => {
  const orders = Array.from({ length: 20 }, (_, index) => order(index + 1, {
    createdAt: '2026-09-07 20:00:00',
    items: [item(1, 'Completo', 1, 1)],
    // el pedido 1 se entrego al final
    deliveries: { 1: `2026-09-07 21:${String(index === 0 ? 59 : index).padStart(2, '0')}:00` },
  }));
  const { pending, delivered } = buildStationQueue(orders, 1);
  assert.deepEqual(pending, []);
  assert.equal(delivered.length, 15, 'por defecto se muestran los ultimos 15');
  assert.equal(delivered[0].code, '0001');
  assert.equal(delivered[0].deliveredAt, '2026-09-07 21:59:00');
  assert.equal(delivered[1].code, '0020');

  assert.equal(buildStationQueue(orders, 1, { limit: 3 }).delivered.length, 3);
  assert.equal(buildStationQueue(orders, 1, { limit: 999 }).delivered.length, 20, 'el tope no supera lo que hay');
  assert.equal(buildStationQueue(orders, 1, { limit: 'x' }).delivered.length, 15);
});

test('el stand null toma los productos sin stand y su entrega con la clave "null"', () => {
  const orders = [
    order(1, { createdAt: '2026-09-07 20:00:00', items: [item(9, 'Rifa', null, 2), item(1, 'Completo', 1, 1)] }),
    order(2, { createdAt: '2026-09-07 20:01:00', items: [item(9, 'Rifa', null, 1)], deliveries: { null: '2026-09-07 20:30:00' } }),
  ];
  const { pending, delivered } = buildStationQueue(orders, null);
  assert.deepEqual(pending.map((entry) => entry.code), ['0001']);
  assert.deepEqual(pending[0].items, [{ name: 'Rifa', qty: 2, note: '' }]);
  assert.deepEqual(delivered.map((entry) => entry.code), ['0002']);
  // la entrega de otro stand no cuenta para este
  assert.deepEqual(buildStationQueue(orders, 1).pending.map((entry) => entry.code), ['0001']);
});
