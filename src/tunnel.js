// Tunel de Cloudflare ("quick tunnel"): publica la caja en internet sin cuenta
// ni dominio, para que los celulares entren con sus datos moviles y solo el PC
// de la impresora necesite internet. La direccion cambia cada vez que se inicia.
import { spawn } from 'node:child_process';

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
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
 * Si el PC pierde internet un buen rato, Cloudflare da de baja la direccion
 * pero cloudflared sigue vivo: los celulares quedan sin caja y nadie se entera.
 * Se prueba la propia direccion y, tras varios fallos seguidos, se reinicia el
 * tunel para obtener una nueva (hay que reimprimir los accesos).
 */
async function checkHealth() {
  if (!state.url || !child) return;
  try {
    const response = await fetch(`${state.url}/api/access`, { signal: AbortSignal.timeout(15000) });
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
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
  child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // cloudflared escribe su registro (incluida la direccion) por stderr
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
