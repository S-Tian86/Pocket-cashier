import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.js';
import { businessDay } from '../src/util.js';
import { buildOrderDocuments, groupByStation } from '../src/tickets.js';
import { dailyReport } from '../src/reports.js';
import { splitAmount } from '../src/lines.js';

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
  // el numero de retiro lleva la inicial del stand, no "PEDIDO"
  assert.match(cocina, new RegExp(`C-${order.code}`));
  assert.doesNotMatch(cocina, /PEDIDO/);
  // compacto: stand, hora y "1 de 2" en pocas lineas y sin el pie del negocio
  assert.match(cocina, /Retira en: COCINA/);
  assert.match(cocina, /Caja: .+ - \d\d:\d\d - 1 de 2/);
  assert.doesNotMatch(cocina, /Gracias/);
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

// Productos propios para las pruebas de stock: no dependen del orden ni de lo que vendan las otras pruebas.
async function stockFixture(prefix) {
  const catalog = await store.getCatalog();
  const cocina = catalog.stations.find((station) => station.name === 'COCINA');
  const bar = catalog.stations.find((station) => station.name === 'BAR');
  const sopaipilla = await store.saveProduct({ name: `${prefix} sopaipilla`, price: 400, stationId: cocina.id, stock: 5 });
  const completo = await store.saveProduct({ name: `${prefix} completo`, price: 2500, stationId: cocina.id, stock: 10 });
  const bebida = await store.saveProduct({ name: `${prefix} bebida`, price: 1000, stationId: bar.id, stock: 10 });
  const pack = await store.saveProduct({ name: `${prefix} 3x1000`, price: 1000, components: [{ productId: sopaipilla.id, qty: 3 }] });
  const combo = await store.saveProduct({
    name: `${prefix} completo + bebida`,
    price: 3000,
    components: [{ productId: completo.id, qty: 1 }, { productId: bebida.id, qty: 1 }],
  });
  return { sopaipilla, completo, bebida, pack, combo };
}

async function stockOf(product) {
  const catalog = await store.getCatalog();
  return catalog.products.find((p) => p.id === product.id).stock;
}

test('vender descuenta el stock y anular lo devuelve', async () => {
  const { completo } = await stockFixture('A');
  const order = await store.createOrder({ items: [{ productId: completo.id, qty: 3 }] });
  assert.equal(await stockOf(completo), 7);
  await store.voidOrder(order.id, 'prueba');
  assert.equal(await stockOf(completo), 10);
  await store.voidOrder(order.id, 'prueba'); // anular de nuevo no devuelve dos veces
  assert.equal(await stockOf(completo), 10);
});

test('sin stock suficiente el pedido se rechaza y no descuenta nada', async () => {
  const { sopaipilla, completo } = await stockFixture('B');
  const before = (await store.listOrders()).length;
  await assert.rejects(
    () => store.createOrder({ items: [{ productId: completo.id, qty: 1 }, { productId: sopaipilla.id, qty: 6 }] }),
    (err) => err.status === 409 && /Solo quedan 5/.test(err.message),
  );
  assert.equal(await stockOf(completo), 10); // el completo, que si alcanzaba, tampoco se descuenta
  assert.equal((await store.listOrders()).length, before);
});

test('una promo es un producto mas y descuenta el stock de lo que incluye', async () => {
  const { sopaipilla, pack } = await stockFixture('C');
  // 3 sopaipillas sueltas de $400 + una promo 3x1000 = $2.200, y ya no alcanza para otra promo
  await assert.rejects(
    () => store.createOrder({ items: [{ productId: sopaipilla.id, qty: 3 }, { productId: pack.id, qty: 1 }] }),
    /Solo quedan 5/,
  );
  const order = await store.createOrder({ items: [{ productId: sopaipilla.id, qty: 2 }, { productId: pack.id, qty: 1 }] });
  assert.equal(order.total, 2 * 400 + 1000);
  assert.equal(await stockOf(sopaipilla), 0);
  await assert.rejects(() => store.createOrder({ items: [{ productId: sopaipilla.id, qty: 1 }] }), /agotado/);
});

test('una promo con productos de dos stands imprime un ticket en cada uno', async () => {
  const { completo, bebida, combo } = await stockFixture('D');
  const order = await store.createOrder({ items: [{ productId: combo.id, qty: 2, note: 'sin mayo' }] });
  assert.equal(order.total, 6000);
  assert.equal(await stockOf(completo), 8);
  assert.equal(await stockOf(bebida), 8);

  const documents = buildOrderDocuments(order);
  assert.deepEqual(documents.map((doc) => doc.kind), ['receipt', 'station', 'station']);
  const receipt = documents[0].ticket.previewText();
  assert.match(receipt, /D completo \+ bebida/);
  assert.match(receipt, /- 2 D completo/);
  const cocina = documents[1].ticket.previewText();
  assert.match(cocina, /2 x D completo/);
  assert.match(cocina, /sin mayo/);
  assert.doesNotMatch(cocina, /2 x D bebida/);
  assert.match(documents[2].ticket.previewText(), /2 x D bebida/);
});

test('el cierre reparte el precio de la promo entre sus stands sin perder pesos', async () => {
  const { combo } = await stockFixture('E');
  const order = await store.createOrder({ items: [{ productId: combo.id, qty: 1 }] });
  const [cocina, bar] = groupByStation(order);
  assert.equal(cocina.items[0].amount + bar.items[0].amount, 3000);
  assert.equal(cocina.items[0].amount, 2143); // 3000 * 2500 / 3500, redondeado
  assert.deepEqual(splitAmount(2, [1, 1, 1, 1]), [1, 1, 0, 0]);
  assert.deepEqual(splitAmount(1000, [0, 0]), [500, 500]);
});

test('reponer suma sobre lo que haya y el formulario no pisa el stock', async () => {
  const { completo } = await stockFixture('F');
  await store.createOrder({ items: [{ productId: completo.id, qty: 4 }] });
  await store.adjustStock(completo.id, { add: 5 });
  assert.equal(await stockOf(completo), 11);
  // guardar el producto con datos viejos (stock 10) no revierte las ventas ni la reposicion
  await store.saveProduct({ ...completo, name: 'F completo italiano' });
  assert.equal(await stockOf(completo), 11);
  await store.adjustStock(completo.id, { set: '' });
  assert.equal(await stockOf(completo), null);
  await assert.rejects(() => store.adjustStock(completo.id, { add: 1 }), /no lleva control/);
});

test('no se puede borrar un producto que esta en una promo ni anidar promos', async () => {
  const { sopaipilla, pack } = await stockFixture('G');
  await assert.rejects(() => store.deleteProduct(sopaipilla.id), /promo "G 3x1000"/);
  await assert.rejects(
    () => store.saveProduct({ name: 'G doble', price: 1800, components: [{ productId: pack.id, qty: 2 }] }),
    /no puede incluir otra promo/,
  );
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

test('un stand sin boleta ni ticket (entradas) no imprime pero suma en el cierre', async () => {
  const { completo } = await catalogIds();
  const station = await store.saveStation({ name: 'ENTRADAS' });
  assert.match(station.color, /^#[0-9a-f]{6}$/); // los stands nuevos traen color
  await store.saveStation({ ...station, printReceipt: false, printTicket: false });
  const entrada = await store.saveProduct({ name: 'Entrada', price: 3000, stationId: station.id, category: 'Entradas' });

  const solo = await store.createOrder({ items: [{ productId: entrada.id, qty: 2 }] });
  assert.equal(buildOrderDocuments(solo).length, 0);
  // a pedido explicito desde Pedidos si se imprime
  assert.equal(buildOrderDocuments(solo, { what: 'receipt' }).length, 1);

  const mixto = await store.createOrder({ items: [{ productId: entrada.id, qty: 1 }, { productId: completo.id, qty: 1 }] });
  const documents = buildOrderDocuments(mixto);
  assert.deepEqual(documents.map((doc) => doc.kind), ['receipt', 'station']);
  const receipt = documents[0].ticket.previewText();
  assert.match(receipt, /Entrada/); // la boleta sale completa para cuadrar con lo pagado
  assert.match(receipt, /RETIRA EN:\n 1\. COCINA/);
  assert.doesNotMatch(documents[1].ticket.previewText(), /1 de/);

  const report = await dailyReport();
  assert.ok(report.byStation.some((row) => row.name === 'ENTRADAS' && row.total >= 9000));

  await store.saveProduct({ ...entrada, active: false });
  await store.saveStation({ ...station, active: false });
});
