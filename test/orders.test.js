import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';
import { businessDay } from '../src/util.js';
import { buildOrderDocuments, groupByStation } from '../src/tickets.js';
import { dailyReport } from '../src/reports.js';

async function catalogIds() {
  const catalog = await store.getCatalog();
  const cocina = catalog.stations.find((station) => station.name === 'COCINA');
  const bar = catalog.stations.find((station) => station.name === 'BAR');
  return {
    completo: catalog.products.find((p) => p.stationId === cocina.id),
    bebida: catalog.products.find((p) => p.stationId === bar.id),
  };
}

test('crea un pedido con totales y vuelto calculados en el servidor', async () => {
  const { completo, bebida } = await catalogIds();
  const order = await store.createOrder({
    items: [{ productId: completo.id, qty: 2 }, { productId: bebida.id, qty: 1 }],
    paymentMethod: 'efectivo',
    amountPaid: 20000,
    cashier: 'Caja 1',
  });
  const total = completo.price * 2 + bebida.price;
  assert.equal(order.total, total);
  assert.equal(order.change, 20000 - total);
  assert.equal(order.items[0].subtotal, completo.price * 2);
  assert.equal(order.status, 'paid');
});

test('el correlativo del dia avanza de uno en uno', async () => {
  const { completo } = await catalogIds();
  const first = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }] });
  const second = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }] });
  assert.equal(second.number, first.number + 1);
  assert.equal(second.code, String(second.number).padStart(4, '0'));
  assert.equal(second.id, `${businessDay()}-${second.code}`);
});

test('pedidos simultaneos de dos cajas no repiten el correlativo', async () => {
  const { completo } = await catalogIds();
  const created = await Promise.all(Array.from({ length: 8 }, () => store.createOrder({ items: [{ productId: completo.id, qty: 1 }] })));
  const numbers = created.map((order) => order.number);
  assert.equal(new Set(numbers).size, numbers.length);
});

test('rechaza pedidos vacios o con productos inexistentes', async () => {
  await assert.rejects(() => store.createOrder({ items: [] }), /no tiene productos/);
  await assert.rejects(() => store.createOrder({ items: [{ productId: 99999, qty: 1 }] }), /no existe/);
});

test('un pedido con dos stands genera boleta mas un ticket por stand', async () => {
  const { completo, bebida } = await catalogIds();
  const order = await store.createOrder({
    items: [{ productId: completo.id, qty: 2 }, { productId: bebida.id, qty: 1 }],
    customer: 'Juan',
  });
  assert.equal(groupByStation(order).length, 2);

  const documents = buildOrderDocuments(order);
  assert.deepEqual(documents.map((doc) => doc.kind), ['receipt', 'station', 'station']);

  const receipt = documents[0].ticket.previewText();
  assert.match(receipt, /BOLETA DE VENTA/);
  assert.match(receipt, /PEDIDO 0*\d+/);
  assert.match(receipt, /TOTAL/);
  assert.match(receipt, /RETIRA EN 2 STANDS/);

  const cocina = documents[1].ticket.previewText();
  assert.match(cocina, /COCINA/);
  assert.match(cocina, new RegExp(`2 x ${completo.name}`));
  assert.match(cocina, /Cliente: Juan/);
  // el ticket de cocina no debe llevar los productos del bar
  assert.doesNotMatch(cocina, new RegExp(bebida.name));
});

test('se puede reimprimir solo un stand', async () => {
  const { completo, bebida } = await catalogIds();
  const order = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }, { productId: bebida.id, qty: 1 }] });
  const [group] = groupByStation(order);
  const documents = buildOrderDocuments(order, { what: `station:${group.stationId}` });
  assert.equal(documents.length, 1);
  assert.equal(documents[0].stationId, group.stationId);
});

test('anular deja el pedido fuera del cierre', async () => {
  const { completo } = await catalogIds();
  const order = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }] });
  const before = await dailyReport(order.day);
  await store.voidOrder(order.id, 'error de la cajera');

  const after = await dailyReport(order.day);
  assert.equal(after.ordersCount, before.ordersCount - 1);
  assert.equal(after.total, before.total - order.total);
  assert.equal(after.voidedCount, before.voidedCount + 1);
});

test('marca y desmarca la entrega de un stand', async () => {
  const { completo } = await catalogIds();
  const order = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }] });
  const stationId = order.items[0].stationId;
  const delivered = await store.markDelivered(order.id, stationId, true);
  assert.ok(delivered.deliveries[String(stationId)]);
  const pending = await store.markDelivered(order.id, stationId, false);
  assert.equal(pending.deliveries[String(stationId)], undefined);
});

test('el cierre agrupa por producto, stand, caja y medio de pago', async () => {
  const day = businessDay();
  const report = await dailyReport(day);
  assert.ok(report.total > 0);
  assert.equal(report.total, report.byProduct.reduce((sum, row) => sum + row.total, 0));
  assert.equal(report.total, report.byStation.reduce((sum, row) => sum + row.total, 0));
  assert.equal(report.total, report.byPayment.reduce((sum, row) => sum + row.total, 0));
  assert.equal(report.total, report.byCashier.reduce((sum, row) => sum + row.total, 0));
  assert.equal(report.averageTicket, Math.round(report.total / report.ordersCount));
});

test('los precios quedan congelados en el pedido aunque cambie el catalogo', async () => {
  const { completo } = await catalogIds();
  const originalPrice = completo.price;
  const order = await store.createOrder({ items: [{ productId: completo.id, qty: 1 }] });
  await store.saveProduct({ ...completo, price: originalPrice + 1000 });

  const stored = await store.getOrder(order.id);
  assert.equal(stored.items[0].price, originalPrice);
  assert.equal(stored.total, originalPrice);

  await store.saveProduct({ ...completo, price: originalPrice }); // deja el catalogo como estaba
});
