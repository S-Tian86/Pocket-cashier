#!/usr/bin/env node
// Pocket Cashier - servidor de caja para bingos, kermeses y ferias.
// Uso: node server.js [--port 8080] [--host 0.0.0.0]
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import * as config from './src/config.js';
import { ROOT } from './src/config.js';
import { buildRouter, handleApi } from './src/api.js';
import { serveStatic, sendText } from './src/router.js';
import { describePrinter } from './src/printer.js';
import { getCatalog } from './src/store.js';

const WEB_DIR = path.join(ROOT, 'web');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current.startsWith('--')) {
      const [key, inline] = current.slice(2).split('=');
      args[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    }
  }
  return args;
}

function localAddresses() {
  const addresses = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const iface of interfaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = config.load();
  const port = Number(args.port || process.env.PORT || settings.server.port) || 8080;
  const host = args.host || process.env.HOST || settings.server.host || '0.0.0.0';

  await getCatalog(); // crea data/catalog.json con el catalogo de ejemplo
  const router = buildRouter();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (await handleApi(router, req, res, url)) return;
        sendText(res, 404, 'No encontrado');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (await serveStatic(res, WEB_DIR, url.pathname)) return;
      }
      sendText(res, 404, 'No encontrado');
    } catch (err) {
      console.error('[http]', err);
      if (!res.headersSent) sendText(res, 500, 'Error interno del servidor');
      else res.end();
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  El puerto ${port} ya esta ocupado. Prueba: node server.js --port ${port + 1}\n`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, host, () => {
    const lines = [
      '',
      `  ${settings.business.name} - Caja lista`,
      '',
      `  En este PC:      http://localhost:${port}`,
      ...localAddresses().map((ip) => `  En la red:       http://${ip}:${port}`),
      '',
      `  Impresora:       ${describePrinter()}`,
      `  Datos:           ${path.join(ROOT, 'data')}`,
      `  Configuracion:   ${config.configPath()}`,
      '',
      '  Ctrl+C para detener.',
      '',
    ];
    console.log(lines.join('\n'));
  });

  const stop = () => {
    console.log('\n  Cerrando caja...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('No se pudo iniciar el servidor:', err);
  process.exit(1);
});
