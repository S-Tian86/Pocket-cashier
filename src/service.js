// Une pedido + diseno de ticket + impresora fisica.
import * as config from './config.js';
import * as store from './store.js';
import { print, checkPrinter, describePrinter } from './printer.js';
import { buildOrderDocuments, buildClosingReport, buildTestTicket } from './tickets.js';
import { dailyReport } from './reports.js';

/** Imprime los documentos de un pedido. Nunca lanza: informa el fallo. */
export async function printOrder(order, { what = 'all' } = {}) {
  const documents = buildOrderDocuments(order, { what });
  if (!documents.length) {
    return { ok: true, printed: [], error: null, documents: [] };
  }

  const openDrawer = config.get('printer.openDrawer', false) && what === 'all' && order.paymentMethod === 'efectivo';
  const printed = [];
  let error = null;

  for (const [index, doc] of documents.entries()) {
    const buffer = doc.ticket.build();
    const withDrawer = openDrawer && index === 0 ? Buffer.concat([buffer, Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa])]) : buffer;
    const result = await print(withDrawer);
    printed.push({ title: doc.title, kind: doc.kind, stationId: doc.stationId, ok: result.ok, skipped: Boolean(result.skipped) });
    if (!result.ok) {
      error = result.error;
      break; // si la impresora fallo, no insistimos con el resto
    }
  }

  await store.registerPrint(order.id, { error });
  return { ok: !error, printed, error, documents: documents.map((doc) => ({ title: doc.title, kind: doc.kind, stationId: doc.stationId })) };
}

export function previewOrder(order, { what = 'all' } = {}) {
  return buildOrderDocuments(order, { what }).map((doc) => ({
    title: doc.title,
    kind: doc.kind,
    stationId: doc.stationId,
    lines: doc.ticket.lines,
    text: doc.ticket.previewText(),
  }));
}

export async function printDailyReport(day) {
  const report = await dailyReport(day);
  const ticket = buildClosingReport(report);
  const result = await print(ticket.build());
  return { ok: result.ok, error: result.error, report, text: ticket.previewText() };
}

export async function printTestPage() {
  const ticket = buildTestTicket();
  const result = await print(ticket.build());
  return { ok: result.ok, error: result.error, text: ticket.previewText() };
}

export async function printerStatus() {
  const status = await checkPrinter();
  return { ...status, description: describePrinter(), width: config.get('printer.charsPerLine', 32) };
}
