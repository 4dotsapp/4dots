import { bundle, unbundle, seal, unseal } from './crypto.js';
import {
  createSession, decryptTransfer, describeConnection, directSupported, endSession, joinSession,
  loadDirectConfig, makePeer, pollSession, postSignal, receiveSealed, sendSealed, watchConnection,
} from './direct.js';
import { createSpeedometer } from './speedometer.js';
import { ease, holdBackdrop, judgeFrames, motionBlur, prefersReducedMotion, rollDigits, tween } from './motion.js';
import { lens } from './lens.js';
import { liquidSlider } from './slider.js';
import { qrSvg } from './qr.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TABS = ['send', 'receive'];
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp']);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const card = $('#card');
const viewport = $('.viewport', card);
const views = Object.fromEntries($$('.view', viewport).map((view) => [view.dataset.view, view]));
const seg = $('.seg');
const thumb = $('.seg-thumb');
const tabs = $$('[role="tab"]', seg);
const note = $('#note');
const fileInput = $('#file-input');
const fileList = $('#files');
const sendBtn = $('#send-btn');
const composeHint = $('#compose-hint');
const burnToggle = $('#burn');
const ttlChips = $$('[data-ttl]');
const reels = $$('.reel');
const pin = $('#pin');
const pinInputs = $$('input', pin);
const pinMsg = $('#pin-msg');
const openBtn = $('#open-btn');

const state = {
  tab: 'send',
  view: { send: 'compose', receive: 'enter' },
  mode: { send: 'server', receive: 'server' },
  files: [], // { id, file, url }
  ttl: 3600,
  maxBytes: 1024 * 1024 * 1024,
  partBytes: 90 * 1024 * 1024,
  drop: null, // { code, expiresAt, burn, revokeToken }
  sending: false,
  receiving: false,
  resultUrls: [],
  directConfig: null, // /api/direct/config, or null when this deployment has no Direct mode
  direct: null, // the active Direct transfer
  pendingDirectLink: '',
};

/* ───────────── helpers ───────────── */

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? +value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const extension = (name) => (name.match(/\.([a-z0-9]{1,4})$/i)?.[1] ?? 'file').toUpperCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, { cache: 'no-store', ...options });
  } catch {
    throw new Error('Network error. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Couldn’t copy. Select it and copy manually.', 'error');
  }
}

/* ───────────── view transitions ───────────── */

let running = null; // the in-flight transition, so a new one can cut it short

/**
 * Swaps the card's content: the glass stays put while views slide through it
 * with motion blur. Starting a new swap snaps any running one to its end, so
 * quick clicks never wait on an animation.
 */
function transition(next, axis = 'y', dir = 1) {
  running?.finish();
  const prev = $('.view.active', viewport);
  if (prev === next) return Promise.resolve();
  const startHeight = viewport.offsetHeight;
  prev?.classList.remove('active');
  next.classList.add('active');
  const endHeight = viewport.offsetHeight;
  if (!prev || prefersReducedMotion()) return Promise.resolve();

  prev.classList.add('leaving');
  prev.inert = true;
  card.classList.add('animating');
  const travel = axis === 'x' ? Math.min(viewport.clientWidth * 0.3, 140) : 22;
  const releaseBackdrop = holdBackdrop();
  const outBlur = motionBlur(prev, axis, { strength: 0.35, max: 12 });
  const inBlur = motionBlur(next, axis, { strength: 0.35, max: 12 });
  const place = (el, offset) => {
    el.style.transform = axis === 'x' ? `translate3d(${offset}px, 0, 0)` : `translate3d(0, ${offset}px, 0)`;
  };

  const control = { stopped: false };
  const frames = [];
  const handle = {
    finish() {
      if (control.stopped) return;
      control.stopped = true;
      outBlur.release();
      inBlur.release();
      releaseBackdrop();
      for (const el of [prev, next]) {
        el.style.removeProperty('transform');
        el.style.removeProperty('opacity');
      }
      prev.classList.remove('leaving');
      prev.inert = false;
      viewport.style.removeProperty('height');
      card.classList.remove('animating');
      if (running === handle) running = null;
    },
  };
  running = handle;

  return tween(axis === 'x' ? 280 : 320, (v) => {
    frames.push(performance.now());
    viewport.style.height = `${startHeight + (endHeight - startHeight) * v}px`;
    const out = -dir * travel * v;
    const into = dir * travel * (1 - v);
    place(prev, out);
    place(next, into);
    prev.style.opacity = String(Math.max(0, 1 - v * 2.5));
    next.style.opacity = String(Math.min(1, v * 2));
    outBlur.track(out);
    inBlur.track(into);
  }, ease.outQuart, control).then(() => {
    // Busy moments (encrypting, downloading) say nothing about the device itself.
    if (!control.stopped && !state.sending && !state.receiving) judgeFrames(frames);
    handle.finish();
  });
}

function go(tab, name, { axis = 'y', dir = 1 } = {}) {
  state.view[tab] = name;
  if (state.tab !== tab) return Promise.resolve();
  return transition(views[`${tab}-${name}`], axis, dir);
}

/* ───────────── tabs ───────────── */

const tabSlider = liquidSlider(seg, thumb, tabs, (i) => setTab(TABS[i]));

function setTab(tab, { instant = false } = {}) {
  if (tab === state.tab) return;
  const dir = TABS.indexOf(tab) > TABS.indexOf(state.tab) ? 1 : -1;
  state.tab = tab;
  for (const button of tabs) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  card.setAttribute('aria-labelledby', `tab-${tab}`);
  const target = views[`${tab}-${state.view[tab]}`];
  if (instant) {
    tabSlider.select(TABS.indexOf(tab), { instant: true });
    $('.view.active', viewport)?.classList.remove('active');
    target.classList.add('active');
    return;
  }
  tabSlider.select(TABS.indexOf(tab));
  transition(target, 'x', dir).then(() => {
    if (tab === 'receive' && state.view.receive === 'enter' && matchMedia('(pointer: fine)').matches) focusPin();
  });
}

for (const button of tabs) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const next = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length];
    setTab(next);
    tabs.find((t) => t.dataset.tab === next).focus();
  });
}

/* ───────────── compose ───────────── */

function autosize() {
  note.style.height = 'auto';
  note.style.height = `${Math.min(note.scrollHeight + 2, 320)}px`;
}

function composeSize() {
  return new TextEncoder().encode(note.value).length + state.files.reduce((sum, entry) => sum + entry.file.size, 0);
}

function refreshCompose() {
  const bytes = composeSize();
  const empty = !note.value.trim() && !state.files.length;
  const tooBig = bytes > state.maxBytes;
  sendBtn.disabled = empty || tooBig || state.sending;
  composeHint.classList.toggle('warn', tooBig);
  composeHint.classList.toggle('idle', !tooBig && !state.files.length);
  if (tooBig) {
    composeHint.textContent = `That’s ${formatBytes(bytes)}. The limit is ${formatBytes(state.maxBytes)}.`;
  } else if (state.mode.send === 'direct') {
    composeHint.textContent = state.files.length
      ? `${plural(state.files.length, 'file')} · ${formatBytes(bytes)} · sent device to device`
      : 'Nothing is stored. Both devices must stay online for the whole transfer.';
  } else if (state.files.length) {
    composeHint.textContent = `${plural(state.files.length, 'file')} · ${formatBytes(bytes)} · encrypted before upload`;
  } else {
    composeHint.textContent = 'Nothing is uploaded until you tap the button.';
  }
}

function addFiles(list) {
  for (const file of list) {
    const duplicate = state.files.some(({ file: f }) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
    if (duplicate) continue;
    const entry = { id: crypto.randomUUID(), file, url: PREVIEWABLE.has(file.type) ? URL.createObjectURL(file) : null };
    state.files.push(entry);
    fileList.append(fileRow(entry));
  }
  refreshCompose();
}

function fileRow({ id, file, url }) {
  return h('li', { class: 'file', 'data-id': id },
    url ? h('img', { class: 'thumb', src: url, alt: '' }) : h('span', { class: 'thumb' }, extension(file.name)),
    h('span', { class: 'file-info' },
      h('span', { class: 'file-name', title: file.name }, file.name),
      h('span', { class: 'file-size' }, formatBytes(file.size))),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${file.name}`, onclick: () => removeFile(id) }, icon('x')),
  );
}

function removeFile(id) {
  const index = state.files.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const [entry] = state.files.splice(index, 1);
  const row = $(`[data-id="${id}"]`, fileList);
  const done = () => {
    row?.remove();
    if (entry.url) URL.revokeObjectURL(entry.url);
  };
  if (row && !prefersReducedMotion()) {
    row.classList.add('out');
    row.addEventListener('animationend', done, { once: true });
  } else {
    done();
  }
  refreshCompose();
}

function clearCompose() {
  for (const entry of state.files) if (entry.url) URL.revokeObjectURL(entry.url);
  state.files = [];
  fileList.replaceChildren();
  note.value = '';
  autosize();
  refreshCompose();
}

note.addEventListener('input', () => {
  autosize();
  refreshCompose();
});

const dropzone = $('#dropzone');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => {
  addFiles(fileInput.files);
  fileInput.value = '';
});

const ttlSlider = liquidSlider($('.chips'), $('.chips-thumb'), ttlChips, (i) => selectTtl(ttlChips[i]),
  ttlChips.findIndex((chip) => chip.getAttribute('aria-checked') === 'true'));

function selectTtl(chip) {
  state.ttl = Number(chip.dataset.ttl);
  ttlSlider.select(ttlChips.indexOf(chip));
  for (const other of ttlChips) {
    const checked = other === chip;
    other.setAttribute('aria-checked', String(checked));
    other.tabIndex = checked ? 0 : -1;
  }
}

for (const chip of ttlChips) {
  chip.addEventListener('click', () => selectTtl(chip));
  chip.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = ttlChips[(ttlChips.indexOf(chip) + step + ttlChips.length) % ttlChips.length];
    selectTtl(next);
    next.focus();
  });
}

/* ───────────── progress ───────────── */

function setProgress(tab, { title, sub, pct } = {}) {
  const root = views[`${tab}-progress`];
  const titleEl = $('.progress-title', root);
  if (title !== undefined && titleEl.textContent !== title) {
    titleEl.textContent = title;
    if (!prefersReducedMotion()) {
      titleEl.animate(
        [{ opacity: 0, transform: 'translateY(6px)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
        { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
    }
  }
  if (sub !== undefined) $('.progress-sub', root).textContent = sub || ' ';
  if (pct !== undefined) {
    const bar = $('.bar', root);
    bar.classList.toggle('indeterminate', pct === null);
    if (pct === null) {
      bar.removeAttribute('aria-valuenow');
    } else {
      bar.style.setProperty('--p', String(pct));
      bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    }
  }
}

/* ───────────── direct mode ───────────── */

const modeButtons = $$('.mode-switch [data-mode]');
const modeRows = $$('.mode-row');

const directEls = {
  send: {
    root: $('#direct-send'),
    code: $('#direct-send-code'),
    state: $('#direct-send-state'),
    sub: $('#direct-send-sub'),
    meter: $('#direct-send-meter'),
    actions: $('#direct-send-actions'),
    subactions: $('#direct-send-subactions'),
    newButton: $('#direct-send-new'),
  },
  receive: {
    root: $('#direct-receive'),
    code: null,
    state: $('#direct-receive-state'),
    sub: $('#direct-receive-sub'),
    meter: $('#direct-receive-meter'),
    actions: null,
    subactions: $('#direct-receive-subactions'),
    newButton: null,
  },
};

// A closed tab cannot wait for the sweeper: drop the session best-effort. The
// DataChannel close tells the other peer immediately either way.
window.addEventListener('pagehide', () => {
  const d = state.direct;
  if (d?.code && d.token) endSession(d.code, d.token);
});

const meters = {};
function meterFor(side) {
  if (!meters[side]) meters[side] = createSpeedometer(directEls[side].meter);
  return meters[side];
}

function setMode(side, mode) {
  if (mode === 'direct') {
    if (!state.directConfig) {
      toast('Direct mode is not available on this deployment.', 'error');
      return;
    }
    if (!directSupported()) {
      toast('This browser cannot open a direct data channel. Server mode still works.', 'error');
      return;
    }
  }
  state.mode[side] = mode;
  for (const button of modeButtons.filter((el) => el.closest('.mode-switch').dataset.side === side)) {
    const selected = button.dataset.mode === mode;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  const compose = views['send-compose'];
  if (side === 'send') {
    compose.classList.toggle('is-direct', mode === 'direct');
    sendBtn.querySelector('span').textContent = mode === 'direct' ? 'Go direct' : 'Encrypt & get code';
    burnToggle.closest('.option').hidden = mode === 'direct';
    refreshCompose();
  } else {
    views['receive-enter'].classList.toggle('is-direct', mode === 'direct');
    openBtn.querySelector('span').textContent = mode === 'direct' ? 'Connect' : 'Unlock';
    const hint = $('.hint', views['receive-enter']);
    hint.textContent = mode === 'direct'
      ? 'Both devices stay online for the whole transfer. Nothing is stored on our server.'
      : 'Decryption happens on this device. Burn-after-reading drops vanish once opened.';
    pinMsg.textContent = '';
  }
}

for (const button of modeButtons) {
  button.addEventListener('click', () => setMode(button.closest('.mode-switch').dataset.side, button.dataset.mode));
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const side = button.closest('.mode-switch').dataset.side;
    const next = state.mode[side] === 'server' ? 'direct' : 'server';
    setMode(side, next);
    button.closest('.mode-switch').querySelector(`[data-mode="${next}"]`)?.focus();
  });
}

function newDirect(side, code = '') {
  const meter = meterFor(side);
  meter.reset();
  return {
    side, code, token: '', pepper: '', expiresAt: 0, ttl: state.ttl,
    total: 0, sentBytes: 0, receivedBytes: 0,
    pc: null, dc: null, rx: null, sealed: null,
    poller: null, stopWatch: null, abort: new AbortController(),
    timer: 0, expiryTimer: 0, pollGrace: 0, connectTimer: 0, queued: [],
    lastBytes: 0, lastTime: 0, ema: 0, samples: 0,
    phase: '', link: '', answered: false, finished: false, failed: false,
    meter,
  };
}

function setDirectStatus(side, title, sub) {
  const els = directEls[side];
  if (title !== undefined) els.state.textContent = title;
  if (sub !== undefined) els.sub.textContent = sub || ' ';
}

function renderDirectCode(code) {
  const el = directEls.send.code;
  el.replaceChildren(...code.split('').map((digit) => h('span', {}, digit)));
  el.setAttribute('aria-label', `Your Direct code is ${code.split('').join(' ')}`);
}

function startDirectClock(d) {
  clearInterval(d.expiryTimer);
  const tick = () => {
    if (state.direct !== d || d.phase !== 'waiting' || d.failed) return;
    const left = Math.max(0, d.expiresAt - Date.now());
    if (!left) {
      failDirect(d, 'The Direct session expired before the other device joined. Ask them to try again.');
      return;
    }
    setDirectStatus(d.side, undefined, `Keep this tab open. Both devices must stay online · ends in ${formatDuration(left)}`);
  };
  tick();
  d.expiryTimer = setInterval(tick, 1000);
}

function cleanupDirect(d, { removeSession = true } = {}) {
  d.abort.abort();
  d.poller?.stop();
  d.poller = null;
  d.stopWatch?.();
  d.stopWatch = null;
  clearInterval(d.timer);
  clearInterval(d.expiryTimer);
  clearTimeout(d.pollGrace);
  clearTimeout(d.connectTimer);
  d.connectTimer = 0;
  d.timer = 0;
  d.expiryTimer = 0;
  d.pollGrace = 0;
  try { d.rx?.close(); } catch { /* already closed */ }
  try { d.dc?.close(); } catch { /* already closed */ }
  try { d.pc?.close(); } catch { /* already closed */ }
  d.rx = null;
  d.dc = null;
  d.pc = null;
  if (removeSession && d.code && d.token) endSession(d.code, d.token);
}

function startSampling(d, readBytes) {
  clearInterval(d.timer);
  d.lastBytes = 0;
  d.lastTime = performance.now();
  d.ema = 0;
  d.samples = 0;
  const tick = () => {
    if (state.direct !== d) return;
    const now = performance.now();
    const bytes = Math.max(0, Math.min(d.total || Infinity, readBytes()));
    const seconds = (now - d.lastTime) / 1000;
    const instant = seconds > 0 ? Math.max(0, ((bytes - d.lastBytes) * 8) / seconds / 1e6) : 0;
    d.lastBytes = bytes;
    d.lastTime = now;
    d.samples++;
    if (d.samples < 2) { d.meter.setBytes(bytes, d.total); return; }
    d.ema = d.samples === 2 ? instant : d.ema * 0.7 + instant * 0.3;
    const remaining = Math.max(0, (d.total || 0) - bytes);
    const eta = remaining <= 0 ? 0 : d.ema > 0.05 ? remaining / ((d.ema * 1e6) / 8) : null;
    d.meter.setSpeed(d.ema);
    d.meter.setEta(eta);
    d.meter.setBytes(bytes, d.total);
  };
  d.timer = setInterval(tick, 500);
  tick();
}

function finishSampling(d) {
  clearInterval(d.timer);
  d.timer = 0;
}

async function refreshLink(d) {
  if (!d.pc || d.failed || d.finished) return;
  const info = await describeConnection(d.pc);
  if (state.direct !== d) return;
  d.link = info.label;
  d.meter.setLink(info.label);
  if (d.phase === 'transferring') {
    setDirectStatus(d.side, 'Transferring', `${info.label} · device to device`);
  }
}

function attachPeer(d) {
  const { pc } = d;
  pc.addEventListener('icecandidate', (event) => {
    if (!event.candidate || !d.code || !d.token) return;
    const candidate = event.candidate.toJSON?.() ?? {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    };
    postSignal(d.code, d.token, 'candidate', candidate).catch(() => {});
  });
  pc.addEventListener('connectionstatechange', () => {
    if (state.direct !== d || d.failed) return;
    if (pc.connectionState === 'connected') {
      clearTimeout(d.connectTimer);
      refreshLink(d);
      // The path is settled. A short grace lets the last candidates land, then
      // the poll stops so the other peer's cleanup cannot produce a 404.
      clearTimeout(d.pollGrace);
      d.pollGrace = setTimeout(() => d.poller?.stop(), 750);
    } else if (pc.connectionState === 'failed') {
      failDirect(d, 'The two devices could not find a path to each other. Nothing was relayed.');
    } else if (pc.connectionState === 'disconnected') {
      setDirectStatus(d.side, d.phase === 'transferring' ? 'Reconnecting…' : 'Connecting',
        'The direct connection dropped. Waiting for it to recover.');
    }
  });
  d.stopWatch = watchConnection(pc, (info) => {
    if (state.direct !== d) return;
    d.link = info.label;
    d.meter.setLink(info.label);
    if (info.kind === 'relay') {
      failDirect(d, 'This connection went through a relay, so it is not direct. Server mode is the honest alternative.');
      return;
    }
    if (d.phase === 'transferring') {
      setDirectStatus(d.side, 'Transferring', `${info.label} · device to device`);
    } else if (d.phase === 'connecting' && info.kind !== 'unknown') {
      setDirectStatus(d.side, 'Connecting', `${info.label} · finishing the handshake`);
    }
  });
}

async function addCandidate(d, data) {
  if (!data || !d.pc) return;
  const candidate = {
    candidate: data.candidate,
    sdpMid: data.sdpMid,
    sdpMLineIndex: data.sdpMLineIndex,
    usernameFragment: data.usernameFragment,
  };
  if (!d.pc.remoteDescription) { d.queued.push(candidate); return; }
  try { await d.pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
}

async function flushCandidates(d) {
  const queued = d.queued.splice(0);
  for (const candidate of queued) {
    try { await d.pc.addIceCandidate(candidate); } catch { /* stale candidate */ }
  }
}

/**
 * ICE can sit in "connecting" for a long time when no path exists. After a
 * bounded wait we say so, rather than leaving the user staring at a spinner.
 */
function armConnectWatchdog(d, seconds = 20) {
  clearTimeout(d.connectTimer);
  d.connectTimer = setTimeout(() => {
    if (state.direct !== d || d.failed || d.finished) return;
    if (d.pc?.connectionState === 'connected') return;
    failDirect(d, 'The two devices could not reach each other in time. No relay was used, so use Server mode instead.');
  }, seconds * 1000);
}

function failDirect(d, message) {
  if (state.direct !== d || d.failed || d.finished) return;
  d.failed = true;
  clearTimeout(d.connectTimer);
  d.phase = 'failed';
  setDirectStatus(d.side, 'Connection failed', message);
  d.meter.setSpeed(null);
  d.meter.setEta(null);
  d.meter.setLink('Not connected');
  directEls[d.side].root.dataset.state = 'failed';
  d.poller?.stop();
  d.stopWatch?.();
  clearInterval(d.timer);
  clearInterval(d.expiryTimer);
  try { d.dc?.close(); } catch { /* already closed */ }
  try { d.pc?.close(); } catch { /* already closed */ }
  if (d.code && d.token) endSession(d.code, d.token);
}

async function beginSending(d) {
  d.phase = 'transferring';
  setDirectStatus('send', 'Transferring', `${d.link || 'Connected'} · device to device`);
  refreshLink(d);
  startSampling(d, () => Math.max(0, d.sentBytes - (d.dc?.bufferedAmount || 0)));
  try {
    await sendSealed(d.dc, d.sealed, {
      signal: d.abort.signal,
      onSent: (sent, total) => { d.sentBytes = sent; d.meter.setBytes(sent, total); },
    });
    if (state.direct !== d) return;
    d.sentBytes = d.total;
    finishSampling(d);
    await refreshLink(d);
    d.finished = true;
    d.meter.setBytes(d.total, d.total);
    d.meter.setDone();
    setDirectStatus('send', 'Done', 'Sent directly. Nothing was stored on the server.');
    directEls.send.root.dataset.state = 'done';
    directEls.send.actions.hidden = true;
    directEls.send.subactions.hidden = true;
    directEls.send.newButton.hidden = false;
    d.finished = true;
    clearCompose();
    cleanupDirect(d);
  } catch (err) {
    if (err.cancelled || err.name === 'AbortError' || state.direct !== d) return;
    failDirect(d, err.message);
  }
}

function handleSenderSignal(d, event) {
  if (state.direct !== d || d.failed || event.role === 'sender') return Promise.resolve();
  if (event.kind === 'join') {
    if (d.phase === 'waiting') {
      d.phase = 'connecting';
      setDirectStatus('send', 'Connecting', 'The recipient joined. Finding a path between the two devices.');
      armConnectWatchdog(d);
    }
  } else if (event.kind === 'answer') {
    d.phase = 'connecting';
    return (async () => {
      try {
        await d.pc.setRemoteDescription({ type: 'answer', sdp: event.data.sdp });
        await flushCandidates(d);
      } catch (err) {
        failDirect(d, 'The handshake failed. Try again, or use Server mode.');
      }
    })();
  } else if (event.kind === 'candidate') {
    return addCandidate(d, event.data);
  } else if (event.kind === 'bye') {
    failDirect(d, 'The recipient cancelled the Direct session.');
  }
  return Promise.resolve();
}

async function sendDirect() {
  if (state.sending || sendBtn.disabled || !state.directConfig) return;
  state.sending = true;
  refreshCompose();
  const text = note.value;
  const files = state.files.map((entry) => entry.file);
  const { ttl } = state;
  const d = newDirect('send');
  state.direct = d;
  directEls.send.root.dataset.state = 'waiting';
  directEls.send.actions.hidden = false;
  directEls.send.subactions.hidden = false;
  directEls.send.newButton.hidden = true;
  renderDirectCode('••••');
  setDirectStatus('send', 'Reserving a code', 'Direct sessions are metadata only: no file is stored.');
  go('send', 'direct');

  try {
    const session = await createSession(ttl);
    if (state.direct !== d) return;
    d.code = session.code;
    d.token = session.sessionToken;
    d.pepper = session.pepper;
    d.expiresAt = session.expiresAt;
    renderDirectCode(d.code);
    d.phase = 'waiting';
    startDirectClock(d);
    setDirectStatus('send', 'Encrypting on your device', 'AES-256-GCM, keyed by your code');
    d.sealed = await seal(d.code, d.pepper, bundle(text, files), (p) => {
      setDirectStatus('send', 'Encrypting on your device', `${Math.round(p * 100)}% · AES-256-GCM, keyed by your code`);
    });
    if (state.direct !== d) return;
    d.total = d.sealed.size;
    d.meter.setCompact(d.total <= 512 * 1024);
    d.meter.setBytes(0, d.total);
    setDirectStatus('send', 'Waiting for the recipient', `Keep this tab open. Both devices must stay online · ends in ${formatDuration(d.expiresAt - Date.now())}`);

    const pc = makePeer(state.directConfig.stunUrls);
    d.pc = pc;
    attachPeer(d);
    const dc = pc.createDataChannel('drop', { ordered: true });
    d.dc = dc;
    dc.addEventListener('open', () => { if (state.direct === d) beginSending(d); }, { once: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await postSignal(d.code, d.token, 'offer', { type: offer.type, sdp: offer.sdp });

    d.poller = pollSession({
      code: d.code,
      token: d.token,
      since: 0,
      onEvents: (event) => handleSenderSignal(d, event),
      onEnded: (message) => failDirect(d, message),
      onError: () => {},
    });
  } catch (err) {
    if (state.direct !== d || err.cancelled) return;
    failDirect(d, err.message);
  } finally {
    state.sending = false;
    refreshCompose();
  }
}

function handleReceiverSignal(d, event) {
  if (state.direct !== d || d.failed || event.role === 'receiver') return Promise.resolve();
  if (event.kind === 'offer') {
    if (d.answered) return Promise.resolve();
    d.answered = true;
    return (async () => {
      try {
        await d.pc.setRemoteDescription({ type: 'offer', sdp: event.data.sdp });
        await flushCandidates(d);
        const answer = await d.pc.createAnswer();
        await d.pc.setLocalDescription(answer);
        await postSignal(d.code, d.token, 'answer', { type: answer.type, sdp: answer.sdp });
        d.phase = 'connecting';
        setDirectStatus('receive', 'Connecting', 'Answer sent. Finding a path between the two devices.');
        armConnectWatchdog(d);
      } catch {
        failDirect(d, 'The handshake failed. Ask the sender to try again, or use Server mode.');
      }
    })();
  }
  if (event.kind === 'candidate') return addCandidate(d, event.data);
  if (event.kind === 'bye') failDirect(d, 'The sender cancelled the Direct session.');
  return Promise.resolve();
}

async function receiveTransfer(d) {
  try {
    const contents = await decryptTransfer(d.code, d.pepper, d.rx.stream, (bytes) => {
      d.receivedBytes = bytes;
    });
    d.rx.ack();
    try { d.dc.send(JSON.stringify({ t: 'done' })); } catch { /* closing */ }
    d.rx.close();
    finishSampling(d);
    await refreshLink(d);
    d.finished = true;
    d.meter.setBytes(d.total, d.total);
    d.meter.setDone();
    setDirectStatus('receive', 'Done', 'Decrypted on this device. Nothing was stored on the server.');
    const pendingImages = renderResult(contents, { direct: true });
    setPin('');
    clearPinError();
    await go('receive', 'result');
    revealImages(pendingImages);
    cleanupDirect(d);
  } catch (err) {
    if (err.cancelled || err.name === 'AbortError' || state.direct !== d) return;
    try { d.dc.send(JSON.stringify({ t: 'error', message: 'This transfer could not be decrypted.' })); } catch { /* closing */ }
    failDirect(d, 'The transfer could not be decrypted. Try again, or ask the sender to use Server mode.');
  }
}

function setupReceiverChannel(d) {
  d.phase = 'connecting';
  setDirectStatus('receive', 'Connecting', d.link ? `${d.link} · opening the data channel` : 'Opening the data channel');
  d.dc.addEventListener('open', () => {
    if (state.direct !== d) return;
    d.phase = 'transferring';
    refreshLink(d);
    setDirectStatus('receive', 'Transferring', `${d.link || 'Connected'} · decrypting on your device`);
  }, { once: true });
  d.rx = receiveSealed(d.dc, {
    onBegin: (total) => {
      if (total > state.maxBytes) {
        d.rx?.fail('That transfer is too large.');
        failDirect(d, `That transfer is larger than the ${formatBytes(state.maxBytes)} limit.`);
        return;
      }
      d.total = total;
      d.meter.setCompact(total <= 512 * 1024);
      d.meter.setBytes(0, total);
      d.phase = 'transferring';
      setDirectStatus('receive', 'Transferring', `${d.link || 'Connected'} · decrypting on your device`);
      startSampling(d, () => d.receivedBytes);
    },
    onBytes: (got, total) => {
      d.receivedBytes = got;
      d.meter.setBytes(got, total || d.total);
    },
  });
  receiveTransfer(d);
}

async function receiveDirect(code) {
  if (state.receiving) return;
  if (!state.directConfig) {
    pinError('Direct mode is not available on this deployment.');
    return;
  }
  state.receiving = true;
  refreshPin();
  document.activeElement?.blur();
  const d = newDirect('receive', code);
  state.direct = d;
  directEls.receive.root.dataset.state = 'connecting';
  directEls.receive.subactions.hidden = false;
  setDirectStatus('receive', 'Connecting', 'Joining the Direct session and asking for the pepper.');
  go('receive', 'direct');

  try {
    const session = await joinSession(code);
    if (state.direct !== d) return;
    d.token = session.sessionToken;
    d.pepper = session.pepper;
    d.expiresAt = session.expiresAt;
    startDirectClock(d);
    const pc = makePeer(state.directConfig.stunUrls);
    d.pc = pc;
    pc.ondatachannel = (event) => {
      if (state.direct !== d) return;
      d.dc = event.channel;
      setupReceiverChannel(d);
    };
    attachPeer(d);
    d.poller = pollSession({
      code,
      token: d.token,
      since: 0,
      onEvents: (event) => handleReceiverSignal(d, event),
      onEnded: (message) => failDirect(d, message),
      onError: () => {},
    });
    setDirectStatus('receive', 'Connecting', 'Waiting for the sender to offer a path.');
    armConnectWatchdog(d, 25);
  } catch (err) {
    if (state.direct !== d) return;
    failDirect(d, err.status === 404
      ? 'No Direct session matches that code. It may have ended, or the sender may be using Server mode.'
      : err.message);
  } finally {
    state.receiving = false;
    refreshPin();
  }
}

function cancelDirectFlow(side) {
  const d = state.direct;
  state.direct = null;
  if (d) cleanupDirect(d);
  directEls[side].root.dataset.state = '';
  if (side === 'send') {
    go('send', 'compose', { dir: -1 });
    refreshCompose();
  } else {
    go('receive', 'enter', { dir: -1 }).then(() => {
      if (matchMedia('(pointer: fine)').matches) focusPin();
    });
  }
}

function fallbackToServer(side) {
  const d = state.direct;
  state.direct = null;
  if (d) cleanupDirect(d);
  setMode(side, 'server');
  if (side === 'send') {
    go('send', 'compose', { dir: -1 });
    refreshCompose();
    toast('Server mode selected. Your message and files are still here.');
  } else {
    go('receive', 'enter', { dir: -1 }).then(() => {
      if (matchMedia('(pointer: fine)').matches) focusPin();
    });
    toast('Server mode selected. A Direct code can only be opened in Direct mode.');
  }
}

/* ───────────── send ───────────── */

/** Sends one part with upload progress. Network and server hiccups are marked retryable. */
function upload(url, blob, reservation, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-reservation', reservation);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON error page; fall through to the generic message.
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new Error(data.error || `Upload failed (${xhr.status}).`);
      // A full store (507) won't clear by re-sending the part, so don't retry it.
      err.retryable = xhr.status >= 500 && xhr.status !== 507;
      reject(err);
    });
    xhr.addEventListener('error', () => reject(Object.assign(new Error('Network error. Check your connection.'), { retryable: true })));
    xhr.send(blob);
  });
}

/**
 * Uploads the sealed drop in parts (Cloudflare takes at most 100 MB per request),
 * retrying a failed part once. Returns how many parts were sent.
 */
async function uploadParts(code, sealed, reservation, partBytes, onProgress) {
  const count = Math.max(1, Math.ceil(sealed.size / partBytes));
  let sent = 0;
  for (let i = 0; i < count; i++) {
    const part = sealed.slice(i * partBytes, Math.min(sealed.size, (i + 1) * partBytes));
    for (let attempt = 1; ; attempt++) {
      try {
        await upload(`/api/drops/${code}/parts/${i}`, part, reservation, (p) => onProgress((sent + p * part.size) / sealed.size));
        break;
      } catch (err) {
        if (attempt >= 2 || !err.retryable) throw err;
      }
    }
    sent += part.size;
  }
  return count;
}

async function send() {
  if (state.sending || sendBtn.disabled) return;
  if (state.mode.send === 'direct') return sendDirect();
  state.sending = true;
  refreshCompose();
  const text = note.value;
  const files = state.files.map((entry) => entry.file);
  const burn = burnToggle.checked;
  const { ttl } = state;

  setProgress('send', { title: 'Reserving a code', sub: 'Picking a free four-digit slot', pct: null });
  go('send', 'progress');
  try {
    // The expiry is declared up front so the server can pick the storage tier
    // before the first byte arrives: RAM for 10 min / 1 hour, SSD for 24 hours.
    const { code, reservation, pepper, partBytes } = await api('/api/drops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ttl }),
    });
    setProgress('send', { title: 'Encrypting on your device', sub: 'AES-256-GCM, keyed by your code' });
    const sealed = await seal(code, pepper, bundle(text, files), (p) => {
      setProgress('send', { sub: `${Math.round(p * 100)}% · AES-256-GCM, keyed by your code`, pct: p });
    });
    setProgress('send', { title: 'Uploading', sub: '0% · only ciphertext leaves this device', pct: 0 });
    const parts = await uploadParts(code, sealed, reservation, partBytes || state.partBytes, (p) => {
      setProgress('send', { sub: `${Math.round(p * 100)}% · only ciphertext leaves this device`, pct: p });
    });
    setProgress('send', { title: 'Sealing it away', sub: 'Storing the encrypted drop', pct: null });
    const drop = await api(`/api/drops/${code}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-reservation': reservation },
      body: JSON.stringify({ ttl, burn, parts }),
    });
    state.drop = drop;
    clearCompose();
    showDone();
  } catch (err) {
    go('send', 'compose', { dir: -1 });
    toast(err.message, 'error');
  } finally {
    state.sending = false;
    refreshCompose();
  }
}

sendBtn.addEventListener('click', send);
note.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send();
});

function buildReels() {
  for (const reel of reels) {
    const strip = $('.strip', reel);
    strip.replaceChildren(...Array.from({ length: 30 }, (_, i) => h('span', {}, String(i % 10))));
  }
}

/** Fills the backdrop with oversized random codes; each row repeats once so it can loop seamlessly. */
function buildTicker() {
  for (const track of $$('.ticker .track')) {
    const codes = Array.from({ length: 6 }, () => String(Math.floor(Math.random() * 10_000)).padStart(4, '0')).join(' ');
    track.replaceChildren(h('span', {}, codes), h('span', {}, codes));
  }
}

function showDone() {
  const { code, burn } = state.drop;
  $('#send-burn').hidden = !burn;
  $('#code').setAttribute('aria-label', `Your code is ${code.split('').join(' ')}`);
  for (const reel of reels) $('.strip', reel).style.transform = 'translate3d(0, 0, 0)';
  startCountdown();
  const visible = state.tab === 'send';
  go('send', 'done');
  // Start spinning as the view slides in so the digits arrive already in motion.
  if (visible) {
    rollDigits(reels, code);
  } else {
    reels.forEach((reel, i) => {
      $('.strip', reel).style.transform = `translate3d(0, ${(-(20 + Number(code[i])) / 30) * 100}%, 0)`;
    });
  }
}

let countdown = 0;
function startCountdown() {
  clearInterval(countdown);
  const label = $('#send-expiry');
  const tick = () => {
    const left = state.drop ? state.drop.expiresAt - Date.now() : 0;
    label.textContent = left > 0 ? `Expires in ${formatDuration(left)}` : 'Expired';
    if (left <= 0) clearInterval(countdown);
  };
  tick();
  countdown = setInterval(tick, 1000);
}

let revokeArmed = 0;
async function revoke(button) {
  const label = $('span', button);
  if (!revokeArmed) {
    label.textContent = 'Tap again to delete';
    revokeArmed = setTimeout(() => {
      revokeArmed = 0;
      label.textContent = 'Delete now';
    }, 3000);
    return;
  }
  clearTimeout(revokeArmed);
  revokeArmed = 0;
  label.textContent = 'Delete now';
  const { code, revokeToken } = state.drop;
  try {
    const res = await fetch(`/api/drops/${code}`, { method: 'DELETE', headers: { 'x-revoke-token': revokeToken } });
    if (!res.ok && res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Couldn’t delete the drop.');
    }
    toast(res.ok ? 'Drop deleted' : 'Already gone');
    newDrop();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function newDrop() {
  state.drop = null;
  clearInterval(countdown);
  go('send', 'compose', { dir: -1 });
}

/* ───────────── receive ───────────── */

const pinValue = () => pinInputs.map((input) => input.value).join('');

function setPin(digits) {
  pinInputs.forEach((input, i) => {
    input.value = digits[i] ?? '';
    input.classList.toggle('filled', Boolean(input.value));
  });
  refreshPin();
}

function refreshPin() {
  openBtn.disabled = pinValue().length !== 4 || state.receiving;
}

function focusPin() {
  (pinInputs.find((input) => !input.value) ?? pinInputs[3]).focus();
}

function clearPinError() {
  pin.classList.remove('error');
  pinMsg.textContent = '';
}

function pinError(message) {
  pin.classList.add('error');
  pinMsg.textContent = message;
  if (!prefersReducedMotion()) {
    pin.animate(
      [0, -12, 10, -7, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 480, easing: 'cubic-bezier(.36,.07,.19,.97)' },
    );
  }
  setPin('');
  focusPin();
}

function popDigit(input) {
  if (prefersReducedMotion()) return;
  input.animate(
    [{ transform: 'translateY(-3px) scale(1.14)', filter: 'blur(3px)' }, { transform: 'translateY(-3px) scale(1)', filter: 'blur(0)' }],
    { duration: 380, easing: 'cubic-bezier(.34,1.56,.64,1)' },
  );
}

let autoSubmit = 0;
function maybeSubmit() {
  clearTimeout(autoSubmit);
  if (pinValue().length === 4) autoSubmit = setTimeout(submitPin, 220);
}

function submitPin() {
  const code = pinValue();
  if (code.length !== 4 || state.receiving) return;
  if (state.mode.receive === 'direct') receiveDirect(code);
  else receive(code);
}

pinInputs.forEach((input, i) => {
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '');
    if (digits.length >= 4) {
      setPin(digits.slice(0, 4)); // autofill or paste into a single box
      pinInputs[3].focus();
    } else {
      input.value = digits.slice(-1);
      input.classList.toggle('filled', Boolean(input.value));
      if (input.value) {
        popDigit(input);
        if (i < 3) pinInputs[i + 1].focus();
      }
    }
    clearPinError();
    refreshPin();
    maybeSubmit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !input.value && i > 0) {
      event.preventDefault();
      const previous = pinInputs[i - 1];
      previous.value = '';
      previous.classList.remove('filled');
      previous.focus();
      refreshPin();
    } else if (event.key === 'ArrowLeft' && i > 0) {
      event.preventDefault();
      pinInputs[i - 1].focus();
    } else if (event.key === 'ArrowRight' && i < 3) {
      event.preventDefault();
      pinInputs[i + 1].focus();
    } else if (event.key === 'Enter') {
      submitPin();
    }
  });
  input.addEventListener('focus', () => input.select());
  input.addEventListener('paste', (event) => {
    const digits = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '');
    if (!digits) return;
    event.preventDefault();
    const merged = (pinValue().slice(0, i) + digits).slice(0, 4);
    setPin(merged);
    focusPin();
    clearPinError();
    maybeSubmit();
  });
});

openBtn.addEventListener('click', submitPin);

async function receive(code) {
  state.receiving = true;
  refreshPin();
  document.activeElement?.blur();
  setProgress('receive', { title: 'Finding your drop', sub: `Code ${code}`, pct: null });
  go('receive', 'progress');
  try {
    let res;
    try {
      res = await fetch(`/api/drops/${code}`, { cache: 'no-store' });
    } catch {
      throw new Error('Network error. Check your connection.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Couldn’t open that code (${res.status}).`);
    }
    const pepper = res.headers.get('x-drop-pepper') ?? '';
    const burn = res.headers.get('x-drop-burn') === '1';
    const expiresAt = Number(res.headers.get('x-drop-expires-at')) || 0;

    // Decrypts as the download streams in, so big drops never sit in memory whole.
    const total = Number(res.headers.get('content-length')) || 0;
    setProgress('receive', { title: 'Downloading', sub: 'Decrypting on your device as it arrives', pct: total ? 0 : null });
    let shown = -1;
    let contents;
    try {
      const plain = await unseal(code, pepper, res.body, (bytes) => {
        const pct = Math.floor((bytes / total) * 100);
        if (!total || pct === shown) return;
        shown = pct;
        setProgress('receive', { sub: `${pct}% · decrypting on your device as it arrives`, pct: bytes / total });
      });
      contents = await unbundle(plain);
    } catch (err) {
      if (err instanceof TypeError) throw new Error('The download was interrupted. Try again.');
      throw new Error('This drop couldn’t be decrypted.');
    }
    const pendingImages = renderResult(contents, { burn, expiresAt });
    setPin('');
    clearPinError();
    await go('receive', 'result');
    revealImages(pendingImages);
  } catch (err) {
    await go('receive', 'enter', { dir: -1 });
    pinError(err.message);
  } finally {
    state.receiving = false;
    refreshPin();
  }
}

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.resultUrls.push(url);
  return url;
}

function downloadLink(file, className) {
  // Served as opaque bytes so a shared HTML or SVG file can't run in this origin if opened.
  const url = objectUrl(new Blob([file.blob], { type: 'application/octet-stream' }));
  return h('a', { class: className, href: url, download: file.name, title: 'Download', 'aria-label': `Download ${file.name}` }, icon('download'));
}

function renderResult({ text, files }, { burn = false, expiresAt = 0, direct = false } = {}) {
  for (const url of state.resultUrls) URL.revokeObjectURL(url);
  state.resultUrls = [];

  const blocks = [];
  const pendingImages = [];
  if (text) {
    blocks.push(h('section', { class: 'block' },
      h('div', { class: 'block-head' },
        h('span', {}, 'Message'),
        h('button', { class: 'text-btn small', type: 'button', onclick: () => copy(text, 'Message copied') }, icon('copy'), 'Copy')),
      h('p', { class: 'message' }, text)));
  }
  const images = files.filter((file) => PREVIEWABLE.has(file.type));
  const others = files.filter((file) => !PREVIEWABLE.has(file.type));
  if (images.length) {
    const single = images.length === 1;
    blocks.push(h('section', { class: `block gallery${single ? ' single' : ''}` },
      images.map((file) => {
        const figure = h('figure', { class: 'shot pending' },
          h('span', { class: 'shot-shimmer', 'aria-hidden': 'true' }),
          h('figcaption', {}, h('span', {}, file.name), downloadLink(file, 'icon-btn')));
        pendingImages.push({ figure, file, single });
        return figure;
      })));
  }
  if (others.length) {
    blocks.push(h('section', { class: 'block' },
      h('ul', { class: 'files' }, others.map((file) => h('li', { class: 'file' },
        h('span', { class: 'thumb' }, extension(file.name)),
        h('span', { class: 'file-info' },
          h('span', { class: 'file-name', title: file.name }, file.name),
          h('span', { class: 'file-size' }, formatBytes(file.size))),
        downloadLink(file, 'icon-btn'))))));
  }
  if (!blocks.length) blocks.push(h('section', { class: 'block' }, h('p', { class: 'message' }, 'This drop is empty.')));
  blocks.forEach((block, i) => block.style.setProperty('--i', String(i)));
  $('#result-body').replaceChildren(...blocks);
  $('#result-meta').textContent = direct
    ? 'Sent directly from the other device. Nothing was stored on the server.'
    : burn
      ? 'Burned on opening. It’s gone from the server.'
      : `Still available for ${formatDuration(expiresAt - Date.now())}`;
  return pendingImages;
}

/* Decode each preview off-document, then reveal it in one frame. Chromium can
   paint a large JPEG in passes; an <img> that is already in the document shows
   those passes. A fully decoded bitmap cannot. */
const IMAGE_DECODE_TIMEOUT_MS = 4000;

function revealImages(items) {
  for (const item of items) revealImage(item).catch(() => {});
}

async function revealImage({ figure, file, single }) {
  const img = h('img', { alt: file.name, decoding: 'async' });
  const url = objectUrl(new Blob([file.blob], { type: file.type }));

  // Dimensions are known before decode finishes: match the placeholder's box to
  // the final one so revealing never shifts the page.
  let markSized;
  const sized = new Promise((resolve) => { markSized = resolve; });
  img.addEventListener('load', markSized, { once: true });
  img.addEventListener('error', markSized, { once: true });
  img.src = url;
  if (img.complete) markSized();

  sized.then(() => {
    if (!single || figure.classList.contains('revealed') || !img.naturalWidth || !img.naturalHeight) return;
    const width = figure.clientWidth;
    if (!width) return;
    const height = Math.min((width * img.naturalHeight) / img.naturalWidth, 420);
    figure.style.aspectRatio = `${width} / ${height}`;
  });

  const decoded = typeof img.decode === 'function' ? img.decode().catch(() => {}) : sized;
  await Promise.race([decoded, new Promise((resolve) => setTimeout(resolve, IMAGE_DECODE_TIMEOUT_MS))]);

  img.style.scale = '0.985';
  figure.classList.remove('pending');
  figure.classList.add('revealed');
  figure.querySelector('.shot-shimmer')?.remove();
  figure.prepend(img);
  void img.offsetWidth;  // commit the starting scale so the lift is animated
  img.style.scale = '';
  if (single) requestAnimationFrame(() => { figure.style.aspectRatio = ''; });
}

/* ───────────── card actions ───────────── */

card.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const code = state.drop?.code;
  const link = code && `${location.origin}/#${code}`;
  switch (button.dataset.action) {
    case 'copy-code':
      copy(code, 'Code copied');
      break;
    case 'copy-link':
      copy(link, 'Link copied');
      break;
    case 'share':
      navigator.share({ title: '4dots', text: `Your 4dots code is ${code}`, url: link }).catch(() => {});
      break;
    case 'qr':
      showQr(code, link);
      break;
    case 'revoke':
      revoke(button);
      break;
    case 'new-drop':
      newDrop();
      break;
    case 'receive-again':
      go('receive', 'enter', { dir: -1 }).then(() => {
        if (matchMedia('(pointer: fine)').matches) focusPin();
      });
      break;
    case 'direct-copy-code':
      if (state.direct?.code) copy(state.direct.code, 'Code copied');
      break;
    case 'direct-copy-link':
      if (state.direct?.code) copy(`${location.origin}/#d${state.direct.code}`, 'Direct link copied');
      break;
    case 'direct-qr':
      if (state.direct?.code) showQr(state.direct.code, `${location.origin}/#d${state.direct.code}`);
      break;
    case 'direct-cancel':
      cancelDirectFlow(state.direct?.side ?? (state.tab === 'receive' ? 'receive' : 'send'));
      break;
    case 'direct-fallback':
      fallbackToServer(state.direct?.side ?? (state.tab === 'receive' ? 'receive' : 'send'));
      break;
    case 'direct-new':
      state.direct = null;
      go('send', 'compose', { dir: -1 });
      refreshCompose();
      break;
  }
});

/* ───────────── QR code ───────────── */

const qrOverlay = $('#qr-overlay');
let qrOpener = null;

function showQr(code, link) {
  $('#qr-tile').replaceChildren(qrSvg(link, `QR code for ${link}`));
  $('#qr-digits').textContent = code;
  $('#qr-host').textContent = location.host;
  qrOpener = document.activeElement;
  qrOverlay.classList.remove('closing');
  qrOverlay.hidden = false;
  $('[data-close]', qrOverlay).focus({ preventScroll: true });
}

function hideQr() {
  if (qrOverlay.hidden || qrOverlay.classList.contains('closing')) return;
  qrOverlay.classList.add('closing');
  setTimeout(() => {
    qrOverlay.hidden = true;
    qrOverlay.classList.remove('closing');
    qrOpener?.focus({ preventScroll: true });
  }, 160);
}

qrOverlay.addEventListener('click', (event) => {
  if (event.target === qrOverlay || event.target.closest('[data-close]')) hideQr();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideQr();
});

/* ───────────── drag, drop, paste, keys ───────────── */

const overlay = $('#drag-overlay');
let dragDepth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');

window.addEventListener('dragenter', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragover', (event) => {
  if (carriesFiles(event)) event.preventDefault();
});
window.addEventListener('dragleave', (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  if (state.sending) return;
  setTab('send');
  if (state.view.send !== 'compose') newDrop();
  addFiles(event.dataTransfer.files);
});

document.addEventListener('paste', (event) => {
  if (state.tab !== 'send' || state.view.send !== 'compose' || state.sending) return;
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
  toast(`${plural(files.length, 'file')} added`);
});

// Typing digits anywhere on the receive screen goes straight into the code.
document.addEventListener('keydown', (event) => {
  if (state.tab !== 'receive' || state.view.receive !== 'enter') return;
  if (!/^\d$/.test(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('input, textarea, [contenteditable]')) return;
  event.preventDefault();
  const target = pinInputs.find((input) => !input.value) ?? pinInputs[3];
  target.focus();
  target.value = event.key;
  target.dispatchEvent(new Event('input', { bubbles: true }));
});

/* ───────────── toast ───────────── */

const toastEl = $('#toast');
let toastTimer = 0;
let toastRun = 0;

function toast(message, tone = 'ok') {
  const run = ++toastRun;
  toastEl.replaceChildren(icon(tone === 'error' ? 'alert' : 'check'), h('span', {}, message));
  toastEl.className = `toast glass ${tone}`;
  toastEl.hidden = false;
  const frames = [
    { opacity: 0, transform: 'translate(-50%, 18px) scale(0.94)', filter: 'blur(10px)' },
    { opacity: 1, transform: 'translate(-50%, 0) scale(1)', filter: 'blur(0)' },
  ];
  toastEl.animate(frames, { duration: 460, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.animate([...frames].reverse(), { duration: 280, easing: 'ease-in', fill: 'forwards' }).finished.then((animation) => {
      if (run !== toastRun) return;
      toastEl.hidden = true;
      animation.cancel();
    });
  }, tone === 'error' ? 4500 : 2200);
}

/* ───────────── light that follows the pointer ───────────── */

const sheenTargets = [card, seg, $('.how'), $('.badge')];
let pointer = null;
let pointerFrame = 0;

window.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'mouse') return;
  pointer = event;
  pointerFrame ||= requestAnimationFrame(() => {
    pointerFrame = 0;
    const { clientX: x, clientY: y } = pointer;
    for (const el of sheenTargets) {
      const rect = el.getBoundingClientRect();
      const near = x > rect.left - 60 && x < rect.right + 60 && y > rect.top - 60 && y < rect.bottom + 60;
      el.style.setProperty('--mx', `${x - rect.left}px`);
      el.style.setProperty('--my', `${y - rect.top}px`);
      el.style.setProperty('--sheen', near ? '1' : '0');
    }
  });
}, { passive: true });

/* ───────────── shared to the app ───────────── */

// Installed as an app, 4dots is a share target. The service worker (sw.js) parks
// what was shared on this device; it lands here as a new drop, ready to encrypt.
const SHARE_CACHE = '4dots-share';

async function takeShared() {
  const cache = await caches.open(SHARE_CACHE);
  const meta = await cache.match('/share/meta').then((res) => res?.json());
  if (!meta) {
    toast('Sharing to 4dots is ready now. Please share that again.');
    return;
  }
  const files = await Promise.all(meta.files.map(async ({ key, name, type, lastModified }) => {
    const blob = await (await cache.match(key)).blob();
    return new File([blob], name, { type, lastModified });
  }));
  await caches.delete(SHARE_CACHE);
  if (meta.text) {
    note.value = note.value ? `${note.value}\n${meta.text}` : meta.text;
    note.dispatchEvent(new Event('input'));
  }
  if (files.length) {
    addFiles(files);
    toast(`${plural(files.length, 'file')} added`);
  }
}

/* ───────────── start ───────────── */

buildReels();
buildTicker();
lens(seg);
lens($('.badge'), { bezel: 10, scale: 20 });
if (navigator.share) $('[data-action="share"]').hidden = false;
refreshCompose();
navigator.serviceWorker?.register('/sw.js').catch(() => {});

if (new URLSearchParams(location.search).has('share')) {
  history.replaceState(null, '', '/');
  takeShared().catch(() => toast('Couldn’t pick up what was shared.', 'error'));
}

// Direct mode only exists on a backend that advertises it in /api/config. The
// Cloudflare Worker flavour does not, so the choice stays hidden there, no
// /api/direct request is made, and Server mode behaves exactly as before.
api('/api/config')
  .then(async (config) => {
    state.maxBytes = config.maxBytes;
    state.partBytes = config.partBytes || state.partBytes;
    for (const el of $$('[data-limit]')) el.textContent = formatBytes(config.maxBytes);
    refreshCompose();
    const direct = await loadDirectConfig(config);
    if (!direct) {
      if (state.pendingDirectLink) {
        state.pendingDirectLink = '';
        toast('Direct mode is not available on this deployment.', 'error');
      }
      return;
    }
    state.directConfig = direct;
    for (const row of modeRows) row.hidden = false;
    if (!directSupported()) {
      for (const button of modeButtons.filter((el) => el.dataset.mode === 'direct')) {
        // Keep it focusable so a click or key press can explain why, rather
        // than leaving a dead control with no message.
        button.setAttribute('aria-disabled', 'true');
        button.title = 'This browser cannot open a direct data channel.';
      }
    }
    if (state.pendingDirectLink) {
      const code = state.pendingDirectLink;
      state.pendingDirectLink = '';
      setTab('receive', { instant: true });
      setMode('receive', 'direct');
      setPin(code);
      receiveDirect(code);
    }
  })
  .catch(() => {
    if (state.pendingDirectLink) {
      state.pendingDirectLink = '';
      toast('Direct mode is not available on this deployment.', 'error');
    }
  });

// Links look like https://host/#1234 (Server) or https://host/#d1234 (Direct).
// Clear the hash right away so a refresh doesn't try to reopen a burned drop.
const linked = location.hash.match(/^#([dD]?)(\d{4})$/);
if (linked) {
  history.replaceState(null, '', location.pathname + location.search);
  setTab('receive', { instant: true });
  setPin(linked[2]);
  if (linked[1]) {
    if (state.directConfig) {
      setMode('receive', 'direct');
      receiveDirect(linked[2]);
    } else {
      state.pendingDirectLink = linked[2];
    }
  } else {
    receive(linked[2]);
  }
}
