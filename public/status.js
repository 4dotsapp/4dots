// Polls /api/status and shows whether 4dots and its storage are reachable. The
// endpoint reports only up/down and latency, so nothing here can reveal a drop.
const STATES = {
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Checking…',
};
const HEADLINE = {
  operational: 'All systems operational',
  degraded: 'Some systems degraded',
  down: 'Service disruption',
  unknown: 'Checking…',
};

const overall = document.querySelector('#overall');
const services = document.querySelector('#services');
const checked = document.querySelector('#checked');

function worst(list) {
  if (list.some((s) => s.status === 'down')) return 'down';
  if (list.some((s) => s.status === 'degraded')) return 'degraded';
  if (list.every((s) => s.status === 'operational')) return 'operational';
  return 'unknown';
}

function row({ name, status, ms }) {
  const el = document.createElement('div');
  el.className = 'svc';
  el.dataset.status = status;
  const dot = document.createElement('span');
  dot.className = 'svc-dot';
  const label = document.createElement('span');
  label.className = 'svc-name';
  label.textContent = name;
  const state = document.createElement('span');
  state.className = 'svc-state';
  state.textContent = STATES[status] || status;
  if (status === 'operational' && Number.isFinite(ms)) state.textContent += ` · ${ms} ms`;
  el.append(dot, label, state);
  return el;
}

function render(data) {
  const list = data.services || [];
  const top = worst(list);
  overall.dataset.status = top;
  overall.querySelector('.label').textContent = HEADLINE[top];
  services.replaceChildren(...list.map(row));
  const when = new Date(data.updated);
  checked.textContent = Number.isNaN(when.getTime()) ? '' : `Last checked ${when.toLocaleTimeString()}`;
}

async function check() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    render(await res.json());
  } catch {
    // The page came from 4dots, but its API didn't answer — report the app as down.
    render({
      updated: new Date().toISOString(),
      services: [
        { id: 'app', name: '4dots', status: 'down' },
        { id: 'storage', name: 'Encrypted storage', status: 'unknown' },
      ],
    });
  }
}

check();
setInterval(check, 30_000);
