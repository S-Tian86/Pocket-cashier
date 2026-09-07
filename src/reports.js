// Resumen del dia: lo que se vendio, por producto, stand, caja y medio de pago.
import { listOrders, listDays } from './store.js';
import { businessDay, localDateTime } from './util.js';

export async function dailyReport(day = businessDay()) {
  const orders = await listOrders({ day });
  const valid = orders.filter((order) => order.status !== 'void');
  const voided = orders.filter((order) => order.status === 'void');

  const byPayment = new Map();
  const byProduct = new Map();
  const byStation = new Map();
  const byCashier = new Map();
  let total = 0;
  let itemsCount = 0;

  for (const order of valid) {
    total += order.total;

    const payment = byPayment.get(order.paymentMethod) || { key: order.paymentMethod, orders: 0, total: 0 };
    payment.orders += 1;
    payment.total += order.total;
    byPayment.set(order.paymentMethod, payment);

    const cashierKey = order.cashier || 'Caja';
    const cashier = byCashier.get(cashierKey) || { name: cashierKey, orders: 0, total: 0 };
    cashier.orders += 1;
    cashier.total += order.total;
    byCashier.set(cashierKey, cashier);

    for (const item of order.items) {
      itemsCount += item.qty;

      const productKey = `${item.productId}|${item.price}`;
      const product = byProduct.get(productKey)
        || { productId: item.productId, name: item.name, price: item.price, qty: 0, total: 0 };
      product.qty += item.qty;
      product.total += item.subtotal;
      byProduct.set(productKey, product);

      const stationKey = String(item.stationId ?? 'null');
      const station = byStation.get(stationKey)
        || { stationId: item.stationId ?? null, name: item.stationName || 'RETIRO', qty: 0, total: 0 };
      station.qty += item.qty;
      station.total += item.subtotal;
      byStation.set(stationKey, station);
    }
  }

  const sortedOrders = [...valid].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    day,
    generatedAt: localDateTime(),
    ordersCount: valid.length,
    voidedCount: voided.length,
    voidedTotal: voided.reduce((sum, order) => sum + order.total, 0),
    itemsCount,
    total,
    cashTotal: byPayment.get('efectivo')?.total || 0,
    averageTicket: valid.length ? Math.round(total / valid.length) : 0,
    firstOrderAt: sortedOrders[0]?.createdAt || null,
    lastOrderAt: sortedOrders.at(-1)?.createdAt || null,
    byPayment: [...byPayment.values()].sort((a, b) => b.total - a.total),
    byProduct: [...byProduct.values()].sort((a, b) => b.total - a.total),
    byStation: [...byStation.values()].sort((a, b) => b.total - a.total),
    byCashier: [...byCashier.values()].sort((a, b) => b.total - a.total),
    hourly: hourlyBreakdown(valid),
  };
}

function hourlyBreakdown(orders) {
  const buckets = new Map();
  for (const order of orders) {
    const hour = order.createdAt.slice(11, 13);
    const bucket = buckets.get(hour) || { hour, orders: 0, total: 0 };
    bucket.orders += 1;
    bucket.total += order.total;
    buckets.set(hour, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

export async function availableDays() {
  return listDays();
}
