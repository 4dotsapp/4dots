import { bundle, unbundle, seal, unseal } from './crypto.js';
import { ease, motionBlur, prefersReducedMotion, rollDigits, tween } from './motion.js';
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
  files: [], // { id, file, url }
  ttl: 3600,
  maxBytes: 1024 * 1024 * 1024,
  partBytes: 90 * 1024 * 1024,
  drop: null, // { code, expiresAt, burn, revokeToken }
  sending: false,
  receiving: false,
  resultUrls: [],
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
  const outBlur = motionBlur(prev, axis, { strength: 0.35, max: 12 });
  const inBlur = motionBlur(next, axis, { strength: 0.35, max: 12 });
  const place = (el, offset) => {
    el.style.transform = axis === 'x' ? `translate3d(${offset}px, 0, 0)` : `translate3d(0, ${offset}px, 0)`;
  };

  const control = { stopped: false };
  const handle = {
    finish() {
      if (control.stopped) return;
      control.stopped = true;
      outBlur.release();
      inBlur.release();
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
    viewport.style.height = `${startHeight + (endHeight - startHeight) * v}px`;
    const out = -dir * travel * v;
    const into = dir * travel * (1 - v);
    place(prev, out);
    place(next, into);
    prev.style.opacity = String(Math.max(0, 1 - v * 2.5));
    next.style.opacity = String(Math.min(1, v * 2));
    outBlur.track(out);
    inBlur.track(into);
  }, ease.outQuart, control).then(() => handle.finish());
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
      err.retryable = xhr.status >= 500;
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
  state.sending = true;
  refreshCompose();
  const text = note.value;
  const files = state.files.map((entry) => entry.file);
  const burn = burnToggle.checked;
  const { ttl } = state;

  setProgress('send', { title: 'Reserving a code', sub: 'Picking a free four-digit slot', pct: null });
  go('send', 'progress');
  try {
    const { code, reservation, pepper, partBytes } = await api('/api/drops', { method: 'POST' });
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
  if (code.length === 4 && !state.receiving) receive(code);
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
    renderResult(contents, { burn, expiresAt });
    setPin('');
    clearPinError();
    await go('receive', 'result');
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

function renderResult({ text, files }, { burn, expiresAt }) {
  for (const url of state.resultUrls) URL.revokeObjectURL(url);
  state.resultUrls = [];

  const blocks = [];
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
    blocks.push(h('section', { class: `block gallery${images.length === 1 ? ' single' : ''}` },
      images.map((file) => h('figure', { class: 'shot' },
        h('img', { src: objectUrl(new Blob([file.blob], { type: file.type })), alt: file.name }),
        h('figcaption', {}, h('span', {}, file.name), downloadLink(file, 'icon-btn'))))));
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
  $('#result-meta').textContent = burn
    ? 'Burned on opening. It’s gone from the server.'
    : `Still available for ${formatDuration(expiresAt - Date.now())}`;
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

/* ───────────── start ───────────── */

buildReels();
buildTicker();
lens(seg);
lens($('.badge'), { bezel: 10, scale: 20 });
if (navigator.share) $('[data-action="share"]').hidden = false;
refreshCompose();

api('/api/config')
  .then((config) => {
    state.maxBytes = config.maxBytes;
    state.partBytes = config.partBytes || state.partBytes;
    for (const el of $$('[data-limit]')) el.textContent = formatBytes(config.maxBytes);
    refreshCompose();
  })
  .catch(() => {});

// Links look like https://host/#1234. Clear the hash right away so a refresh
// doesn't try to reopen a drop that burned on first read.
const linked = location.hash.match(/^#(\d{4})$/);
if (linked) {
  history.replaceState(null, '', location.pathname + location.search);
  setTab('receive', { instant: true });
  setPin(linked[1]);
  receive(linked[1]);
}
