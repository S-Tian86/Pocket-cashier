// Envio de bytes ESC/POS a la impresora fisica.
// Modos soportados:
//   network -> impresora con IP/ethernet o WiFi (puerto 9100)
//   device  -> archivo de dispositivo (Linux: /dev/usb/lp0, Windows: COM3)
//   command -> se delega en el sistema (lp -o raw en Linux/Mac, copy /b en Windows)
//   file    -> escribe los bytes en un archivo (para probar sin impresora)
//   none    -> no imprime (modo demostracion)
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import * as config from './config.js';
import { ROOT } from './config.js';

const execAsync = promisify(exec);

// Una sola cola: dos cajas en red no pueden mezclar sus bytes en el papel.
let queue = Promise.resolve();

export function printerConfig(overrides = {}) {
  return { ...config.get('printer', {}), ...overrides };
}

export function describePrinter(cfg = printerConfig()) {
  if (!cfg.enabled || cfg.mode === 'none') return 'Impresion desactivada (modo demostracion)';
  switch (cfg.mode) {
    case 'network': return `Red ${cfg.host}:${cfg.port}`;
    case 'device': return `Dispositivo ${cfg.device}`;
    case 'command': return `Comando: ${cfg.command}`;
    case 'file': return `Archivo ${cfg.file}`;
    default: return `Modo desconocido: ${cfg.mode}`;
  }
}

/** Encola un trabajo de impresion. Resuelve con { ok, mode, error }. */
export function print(buffer, overrides = {}) {
  const job = () => send(buffer, printerConfig(overrides));
  const result = queue.then(job, job);
  queue = result.catch(() => {});
  return result;
}

async function send(buffer, cfg) {
  if (!cfg.enabled || cfg.mode === 'none') {
    return { ok: true, mode: 'none', skipped: true, error: null };
  }
  try {
    switch (cfg.mode) {
      case 'network': await sendNetwork(buffer, cfg); break;
      case 'device': await sendDevice(buffer, cfg); break;
      case 'command': await sendCommand(buffer, cfg); break;
      case 'file': await sendFile(buffer, cfg); break;
      default: throw new Error(`Modo de impresion no soportado: ${cfg.mode}`);
    }
    return { ok: true, mode: cfg.mode, error: null };
  } catch (err) {
    console.error(`[impresora] fallo (${cfg.mode}):`, err.message);
    return { ok: false, mode: cfg.mode, error: friendlyError(err, cfg) };
  }
}

function friendlyError(err, cfg) {
  const code = err.code || '';
  if (code === 'ECONNREFUSED') return `La impresora en ${cfg.host}:${cfg.port} rechazo la conexion. Revisa que este encendida y en la misma red.`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `No se llega a ${cfg.host}. Revisa la IP y la red.`;
  if (code === 'ETIMEDOUT') return `La impresora en ${cfg.host}:${cfg.port} no respondio a tiempo.`;
  if (code === 'ENOENT') return `No existe ${cfg.device || cfg.command}. Revisa la configuracion de la impresora.`;
  if (code === 'EACCES') return `Sin permisos para usar ${cfg.device}. En Linux agrega tu usuario al grupo lp.`;
  return err.message;
}

function sendNetwork(buffer, cfg) {
  const timeout = Number(cfg.timeout) || 6000;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: Number(cfg.port) || 9100 });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(timeout);
    socket.on('timeout', () => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    socket.on('error', finish);
    socket.on('connect', () => {
      socket.write(buffer, () => socket.end());
    });
    socket.on('close', () => finish(null));
  });
}

async function sendDevice(buffer, cfg) {
  const handle = await fsp.open(cfg.device, 'w');
  try {
    await handle.write(buffer);
  } finally {
    await handle.close();
  }
}

async function sendFile(buffer, cfg) {
  const target = path.isAbsolute(cfg.file) ? cfg.file : path.join(ROOT, cfg.file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.appendFile(target, buffer);
}

async function sendCommand(buffer, cfg) {
  const tmpFile = path.join(os.tmpdir(), `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  await fsp.writeFile(tmpFile, buffer);
  try {
    const command = String(cfg.command || '').includes('{file}')
      ? cfg.command.replaceAll('{file}', quote(tmpFile))
      : `${cfg.command} ${quote(tmpFile)}`;
    await execAsync(command, { timeout: Number(cfg.timeout) || 6000, windowsHide: true });
  } finally {
    fs.rm(tmpFile, { force: true }, () => {});
  }
}

function quote(value) {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Comprobacion rapida de alcance, sin gastar papel. */
export async function checkPrinter(overrides = {}) {
  const cfg = printerConfig(overrides);
  const description = describePrinter(cfg);
  if (!cfg.enabled || cfg.mode === 'none') {
    return { ok: true, reachable: false, mode: 'none', description, message: 'Impresion desactivada' };
  }
  try {
    if (cfg.mode === 'network') {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: cfg.host, port: Number(cfg.port) || 9100 });
        socket.setTimeout(Number(cfg.timeout) || 6000);
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('timeout', () => { socket.destroy(); reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
        socket.on('error', (err) => { socket.destroy(); reject(err); });
      });
    } else if (cfg.mode === 'device') {
      await fsp.access(cfg.device, fs.constants.W_OK);
    }
    return { ok: true, reachable: true, mode: cfg.mode, description, message: 'Impresora disponible' };
  } catch (err) {
    return { ok: false, reachable: false, mode: cfg.mode, description, message: friendlyError(err, cfg) };
  }
}
