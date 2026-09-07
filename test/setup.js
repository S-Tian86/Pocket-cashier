// Aisla las pruebas: datos y configuracion en carpetas temporales.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-cashier-test-'));
process.env.POCKET_CASHIER_DATA = path.join(dir, 'data');
process.env.POCKET_CASHIER_CONFIG = path.join(dir, 'config.json');
fs.writeFileSync(process.env.POCKET_CASHIER_CONFIG, JSON.stringify({
  business: { name: 'BINGO DE PRUEBA', subtitle: 'Test', footer: 'Gracias!' },
  currency: { symbol: '$', decimals: 0, thousandsSep: '.', decimalSep: ',' },
  businessDayStartHour: 5,
  printer: { enabled: false, mode: 'none', charsPerLine: 32, encoding: 'cp850', barcode: 'code39' },
  tickets: { printReceipt: true, printStationTickets: true, receiptCopies: 1, stationTicketCopies: 1 },
}));

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
