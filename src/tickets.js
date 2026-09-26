// Diseno de los documentos que salen por la impresora:
//   - la boleta del cliente (detalle + total pagado + vuelto)
//   - un ticket de retiro por cada estacion/stand del pedido
//   - el cierre de caja del dia
import * as config from './config.js';
import { Ticket } from './escpos.js';
import { money, humanDate, humanDateTime, humanTime } from './util.js';
import { pickupLines } from './lines.js';

export const PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  debito: 'Debito',
  credito: 'Credito',
  transferencia: 'Transferencia',
  otro: 'Otro',
};

export function paymentLabel(method) {
  return PAYMENT_LABELS[method] || method || 'Otro';
}

function newTicket() {
  const printer = config.get('printer', {});
  return new Ticket({
    width: Number(printer.charsPerLine) || 32,
    encoding: printer.encoding || 'cp850',
    codepage: printer.codepage,
    cancelChineseMode: Boolean(printer.cancelChineseMode),
  });
}

function header(ticket) {
  const business = config.get('business', {});
  ticket.align('center');
  if (business.name) {
    ticket.size(1, 2).bold(true).wrapped(business.name).bold(false).size(1, 1);
  }
  if (business.subtitle) ticket.wrapped(business.subtitle);
  if (business.extraLine) ticket.wrapped(business.extraLine);
  ticket.align('left');
  return ticket;
}

function footer(ticket, order) {
  const business = config.get('business', {});
  const barcodeMode = config.get('printer.barcode', 'code39');
  ticket.reset().feed(1).align('center');
  if (business.footer) ticket.wrapped(business.footer);
  if (order) ticket.code(order.code, barcodeMode);
  ticket.align('left');
  return ticket;
}

/** Agrupa los productos por estacion: una estacion = un ticket de retiro. Las promos van abiertas. */
export function groupByStation(order) {
  const groups = new Map();
  for (const line of pickupLines(order)) {
    const key = String(line.stationId ?? 'null');
    if (!groups.has(key)) {
      groups.set(key, { stationId: line.stationId ?? null, stationName: line.stationName || 'RETIRO', items: [] });
    }
    groups.get(key).items.push(line);
  }
  return [...groups.values()];
}

export function buildReceipt(order, { copyLabel = '' } = {}) {
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');

  ticket.align('center').size(2, 2).bold(true).line(`PEDIDO ${order.code}`).bold(false).size(1, 1);
  ticket.line(order.status === 'void' ? '*** ANULADO ***' : 'BOLETA DE VENTA');
  if (copyLabel) ticket.line(copyLabel);
  ticket.align('left').sep();

  ticket.cols('Fecha', humanDateTime(order.createdAt));
  ticket.cols('Caja', order.cashier || '-');
  if (order.customer) ticket.cols('Cliente', order.customer);
  ticket.sep();

  for (const item of order.items) {
    ticket.wrapped(item.name);
    ticket.cols(`  ${item.qty} x ${money(item.price)}`, money(item.subtotal));
    for (const component of item.components || []) {
      ticket.wrapped(`- ${component.qty * item.qty} ${component.name}`, { indent: '  ' });
    }
    if (item.note) ticket.wrapped(`(${item.note})`, { indent: '  ' });
  }

  ticket.sep();
  ticket.bold(true).size(1, 2).cols('TOTAL', money(order.total)).size(1, 1).bold(false);
  ticket.cols(paymentLabel(order.paymentMethod), money(order.amountPaid));
  if (order.change > 0) ticket.cols('Vuelto', money(order.change));
  ticket.cols('Articulos', String(order.items.reduce((sum, item) => sum + item.qty, 0)));

  const groups = groupByStation(order);
  if (groups.length) {
    ticket.sep();
    ticket.line(groups.length > 1 ? `RETIRA EN ${groups.length} STANDS:` : 'RETIRA EN:');
    groups.forEach((group, index) => {
      ticket.line(` ${index + 1}. ${group.stationName}`);
    });
  }
  if (order.note) {
    ticket.sep();
    ticket.wrapped(`Nota: ${order.note}`);
  }

  footer(ticket, order);
  ticket.cut({ feedLines: Number(config.get('printer.feedLines', 3)) });
  return ticket;
}

export function buildStationTicket(order, group, index, totalTickets) {
  const ticket = newTicket();
  ticket.align('center');
  ticket.size(2, 2).bold(true).wrapped(group.stationName).bold(false).size(1, 1);
  ticket.line('TICKET DE RETIRO');
  ticket.sep('=');
  ticket.size(2, 2).bold(true).line(`PEDIDO ${order.code}`).bold(false).size(1, 1);
  if (totalTickets > 1) ticket.line(`Ticket ${index + 1} de ${totalTickets}`);
  ticket.line(humanTime(order.createdAt));
  if (order.status === 'void') ticket.bold(true).line('*** ANULADO ***').bold(false);
  ticket.align('left').sep();

  for (const item of group.items) {
    ticket.size(1, 2);
    ticket.wrapped(`${item.qty} x ${item.name}`);
    ticket.size(1, 1);
    // la boleta dice el nombre de la promo: el stand ve de cual viene para cuadrar
    if (item.promo) ticket.wrapped(`de: ${item.promo}`, { indent: '   ' });
    if (item.note) ticket.wrapped(`(${item.note})`, { indent: '   ' });
  }

  ticket.sep();
  if (order.customer) ticket.wrapped(`Cliente: ${order.customer}`);
  if (order.note) ticket.wrapped(`Nota: ${order.note}`);
  ticket.line(`Caja: ${order.cashier || '-'}`);

  footer(ticket, order);
  ticket.cut({ feedLines: Number(config.get('printer.feedLines', 3)) });
  return ticket;
}

/**
 * Arma todos los documentos de un pedido.
 * `what`: 'all' | 'receipt' | 'stations' | 'station:<id>'
 */
export function buildOrderDocuments(order, { what = 'all' } = {}) {
  const tickets = config.get('tickets', {});
  const documents = [];
  const groups = groupByStation(order);

  const wantsReceipt = what === 'all' ? tickets.printReceipt !== false : what === 'receipt';
  const wantsStations = what === 'all' ? tickets.printStationTickets !== false : what === 'stations' || what.startsWith('station:');

  if (wantsReceipt) {
    const copies = what === 'receipt' ? 1 : Math.max(1, Number(tickets.receiptCopies) || 1);
    for (let copy = 0; copy < copies; copy += 1) {
      documents.push({
        kind: 'receipt',
        stationId: null,
        title: `Boleta ${order.code}`,
        ticket: buildReceipt(order, { copyLabel: copy > 0 ? 'COPIA' : '' }),
      });
    }
  }

  if (wantsStations) {
    const only = what.startsWith('station:') ? what.slice('station:'.length) : null;
    const copies = only ? 1 : Math.max(1, Number(tickets.stationTicketCopies) || 1);
    groups.forEach((group, index) => {
      if (only !== null && String(group.stationId ?? 'null') !== only) return;
      for (let copy = 0; copy < copies; copy += 1) {
        documents.push({
          kind: 'station',
          stationId: group.stationId,
          title: `Retiro ${group.stationName} (${index + 1}/${groups.length})`,
          ticket: buildStationTicket(order, group, index, groups.length),
        });
      }
    });
  }

  return documents;
}

export function buildClosingReport(report) {
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');
  ticket.align('center').bold(true).size(1, 2).line('CIERRE DE CAJA').size(1, 1).bold(false);
  ticket.line(humanDate(report.day));
  ticket.line(`Emitido ${humanDateTime(report.generatedAt)}`);
  ticket.align('left').sep();

  ticket.cols('Pedidos', String(report.ordersCount));
  if (report.voidedCount) ticket.cols('Anulados', String(report.voidedCount));
  if (report.firstOrderAt) ticket.cols('Primer pedido', humanTime(report.firstOrderAt));
  if (report.lastOrderAt) ticket.cols('Ultimo pedido', humanTime(report.lastOrderAt));
  ticket.cols('Articulos vendidos', String(report.itemsCount));

  ticket.sep();
  ticket.bold(true).line('MEDIOS DE PAGO').bold(false);
  for (const row of report.byPayment) {
    ticket.cols(`${paymentLabel(row.key)} (${row.orders})`, money(row.total));
  }

  ticket.sep();
  ticket.bold(true).line('VENTAS POR PRODUCTO').bold(false);
  for (const row of report.byProduct) {
    ticket.wrapped(row.name);
    ticket.cols(`  ${row.qty} x ${money(row.price)}`, money(row.total));
  }

  if (report.byStation.length > 1) {
    ticket.sep();
    ticket.bold(true).line('POR STAND').bold(false);
    for (const row of report.byStation) {
      ticket.cols(`${row.name} (${row.qty})`, money(row.total));
    }
  }

  if (report.byCashier.length > 1) {
    ticket.sep();
    ticket.bold(true).line('POR CAJA').bold(false);
    for (const row of report.byCashier) {
      ticket.cols(`${row.name} (${row.orders})`, money(row.total));
    }
  }

  ticket.sep('=');
  ticket.bold(true).size(1, 2).cols('TOTAL', money(report.total)).size(1, 1).bold(false);
  if (report.cashTotal !== report.total) ticket.cols('Efectivo en caja', money(report.cashTotal));
  if (report.voidedTotal) ticket.cols('Anulado (no suma)', money(report.voidedTotal));

  ticket.feed(1).align('center').line('Firma: ______________');
  ticket.align('left');
  ticket.cut({ feedLines: Number(config.get('printer.feedLines', 3)) });
  return ticket;
}

export function buildTestTicket() {
  const printer = config.get('printer', {});
  const ticket = newTicket();
  header(ticket);
  ticket.sep('=');
  ticket.align('center').bold(true).size(2, 2).line('PRUEBA').size(1, 1).bold(false);
  ticket.align('left').sep();
  ticket.line('Acentos: a\u00f1os, ni\u00f1o, PA\u00d1OL');
  ticket.line('Vocales: \u00e1\u00e9\u00ed\u00f3\u00fa \u00c1\u00c9\u00cd\u00d3\u00da');
  ticket.line('Signos: \u00bfcu\u00e1nto? \u00a11.000!');
  ticket.cols('Ancho', `${printer.charsPerLine} caracteres`);
  ticket.cols('Codificacion', String(printer.encoding));
  ticket.cols('Modo', String(printer.mode));
  ticket.sep();
  ticket.line('1234567890'.repeat(4).slice(0, Number(printer.charsPerLine) || 32));
  ticket.align('center').code('PRUEBA1', config.get('printer.barcode', 'code39'));
  ticket.align('left');
  ticket.cut({ feedLines: Number(printer.feedLines || 3) });
  return ticket;
}
