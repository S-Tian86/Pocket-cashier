// Tunel de Cloudflare ("quick tunnel"): publica la caja en internet sin cuenta
// ni dominio, para que los celulares entren con sus datos moviles y solo el PC
// de la impresora necesite internet. La direccion cambia cada vez que se inicia.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

import { paths } from './store.js';

const LOG_PATH = path.join(paths.DATA_DIR, 'cloudflared.log');
// api.trycloudflare.com es donde cloudflared pide la direccion: aparece en sus errores y no es la caja
const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
const RETRY_MS = 5000;
const CHECK_MS = 60 * 1000;
const MAX_CHECK_FAILURES = 3;

const state = { active: false, url: '', error: '', startedAt: '' };
let child = null;
let stopping = false;
let onUrl = () => {};
let checkTimer = null;
let checkFailures = 0;

/**
 * Resuelve con DNS sobre HTTPS y no con el del sistema: el DNS del celular que
 * comparte internet guarda un "no existe" si se pregunto por la direccion antes
 * de que Cloudflare la publicara, y el tunel pareceria caido estando bien.
 */
async function resolveViaHttps(host) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  return (data.Answer || []).filter((answer) => answer.type === 1).map((answer) => answer.data);
}

/** Pide /api/access a la IP resuelta, presentandose con el nombre del tunel. */
function probe(ip, host) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: ip, servername: host, path: '/api/access', headers: { host }, timeout: 15000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error('sin respuesta')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * Si el PC pierde internet un buen rato, Cloudflare da de baja la direccion
 * pero cloudflared sigue vivo: los celulares quedan sin caja y nadie se entera.
 * Se prueba la propia direccion y, tras varios fallos seguidos, se reinicia el
 * tunel para obtener una nueva (hay que reimprimir los accesos).
 */
async function checkHealth() {
  if (!state.url || !child) return;
  try {
    const host = new URL(state.url).hostname;
    const [ip] = await resolveViaHttps(host);
    if (!ip) throw new Error('la direccion ya no existe');
    const status = await probe(ip, host);
    if (status >= 500) throw new Error(`HTTP ${status}`);
    checkFailures = 0;
    if (state.error) state.error = '';
  } catch (err) {
    checkFailures += 1;
    state.error = `La direccion no responde (${checkFailures}/${MAX_CHECK_FAILURES}): ${err.cause?.code || err.message}`;
    if (checkFailures >= MAX_CHECK_FAILURES) {
      console.error(`  [tunel] ${state.url} dejo de responder: se reinicia el tunel con una direccion nueva`);
      checkFailures = 0;
      child?.kill(); // el handler de 'exit' lo vuelve a lanzar
    }
  }
}

export function status() {
  return { ...state };
}

/** Inicia cloudflared apuntando al puerto local. `urlChanged` avisa cada direccion nueva. */
export function start(port, { binary = process.env.CLOUDFLARED || 'cloudflared', urlChanged = () => {} } = {}) {
  onUrl = urlChanged;
  stopping = false;
  state.active = true;
  launch(port, binary);
  checkTimer = setInterval(checkHealth, CHECK_MS);
  checkTimer.unref();
}

function launch(port, binary) {
  state.url = '';
  state.error = '';
  // http2 va por TCP: QUIC (UDP, el predeterminado) se corta seguido en redes
  // de celular, y un quick tunnel que pierde su conexion queda dado de baja
  child = spawn(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // cloudflared escribe su registro (incluida la direccion) por stderr; se guarda para diagnosticar cortes
  const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  log.write(`\n--- ${new Date().toISOString()} inicio del tunel ---\n`);
  child.stderr.pipe(log);
  const scan = (chunk) => {
    const found = URL_PATTERN.exec(String(chunk));
    if (found && found[0] !== state.url) {
      state.url = found[0];
      state.startedAt = new Date().toISOString();
      onUrl(state.url);
    }
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);

  child.on('error', (err) => {
    state.error = err.code === 'ENOENT'
      ? 'No se encontro cloudflared. Instalalo con: winget install --id Cloudflare.cloudflared'
      : `No se pudo iniciar cloudflared: ${err.message}`;
    state.active = false;
    console.error(`\n  [tunel] ${state.error}\n`);
  });

  child.on('exit', (code) => {
    child = null;
    state.url = '';
    if (stopping || !state.active) return;
    // se corto (sin internet, el celular se desconecto): se reintenta con una direccion nueva
    state.error = `El tunel se cerro (codigo ${code}). Reintentando...`;
    console.error(`  [tunel] ${state.error}`);
    setTimeout(() => { if (state.active && !stopping) launch(port, binary); }, RETRY_MS).unref();
  });
}

export function stop() {
  stopping = true;
  state.active = false;
  clearInterval(checkTimer);
  child?.kill();
}
