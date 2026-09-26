// Lo que cada stand tiene que entregar. Una promo no se entrega como tal: se abre
// en sus productos y cada uno sale en el ticket (y la cola) de su propio stand.

/**
 * Lineas de retiro de un pedido. `amount` es lo que esa linea aporta a la venta
 * del stand: en una promo, su precio se reparte segun el precio normal de cada
 * producto, para que el cierre por stand siga sumando el total del dia.
 */
export function pickupLines(order) {
  const lines = [];
  for (const item of order.items) {
    if (item.components?.length) {
      const shares = splitAmount(item.subtotal, item.components.map((c) => (Number(c.price) || 0) * c.qty));
      item.components.forEach((component, index) => {
        lines.push({
          productId: component.productId,
          name: component.name,
          qty: component.qty * item.qty,
          note: item.note || '',
          promo: item.name,
          stationId: component.stationId ?? null,
          stationName: component.stationName || 'RETIRO',
          amount: shares[index],
        });
      });
    } else {
      lines.push({
        productId: item.productId,
        name: item.name,
        qty: item.qty,
        note: item.note || '',
        promo: '',
        stationId: item.stationId ?? null,
        stationName: item.stationName || 'RETIRO',
        amount: item.subtotal,
      });
    }
  }
  return lines;
}

/**
 * Reparte `total` en proporcion a `weights` sin perder ni inventar pesos: se
 * redondea hacia abajo y el resto va a las partes con mayor decimal.
 */
export function splitAmount(total, weights) {
  if (!weights.length) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? weights : weights.map(() => 1); // promo de productos a $0: partes iguales
  const baseSum = sum > 0 ? sum : weights.length;
  const exact = base.map((weight) => (total * weight) / baseSum);
  const parts = exact.map(Math.floor);
  let remainder = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((value, index) => [value - Math.floor(value), index]).sort((a, b) => b[0] - a[0]);
  for (const [, index] of order) {
    if (remainder <= 0) break;
    parts[index] += 1;
    remainder -= 1;
  }
  return parts;
}

/** Unidades de cada producto que consume una lista de items (las promos por sus componentes). */
export function stockNeeds(items) {
  const needs = new Map();
  const add = (productId, qty) => needs.set(productId, (needs.get(productId) || 0) + qty);
  for (const item of items) {
    if (item.components?.length) {
      for (const component of item.components) add(component.productId, component.qty * item.qty);
    } else {
      add(item.productId, item.qty);
    }
  }
  return needs;
}
