// The Direct transfer gauge.
//
// The needle shows measured throughput only: the caller samples real bytes on
// a fixed interval, smooths them, and passes the result here. The gauge never
// invents a speed: with fewer than two samples it shows "--". The small bar
// under it is a fuel gauge for the estimated time left, not a percentage.
const NS = 'http://www.w3.org/2000/svg';
const CENTER = { x: 120, y: 124 };
const RADIUS = 92;
const SCALES = [10, 50, 100, 250, 500, 1000, 2500, 10_000];

function node(tag, attrs = {}, text) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pair = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pair(minutes)}:${pair(secs)}` : `${pair(minutes)}:${pair(secs)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value < 10 ? +value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function point(ratio, radius) {
  const angle = Math.PI - Math.min(1, Math.max(0, ratio)) * Math.PI;
  return {
    x: CENTER.x + radius * Math.cos(angle),
    y: CENTER.y - radius * Math.sin(angle),
  };
}

export function createSpeedometer(root) {
  root.classList.add('speedo');
  root.replaceChildren();

  const dial = document.createElement('div');
  dial.className = 'speedo-dial';
  const svg = node('svg', {
    viewBox: '0 0 240 140',
    class: 'speedo-svg',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  const track = node('path', {
    class: 'speedo-track',
    d: `M ${CENTER.x - RADIUS} ${CENTER.y} A ${RADIUS} ${RADIUS} 0 0 1 ${CENTER.x + RADIUS} ${CENTER.y}`,
  });
  const ticks = node('g', { class: 'speedo-ticks' });
  const labels = node('g', { class: 'speedo-scale' });
  const needle = node('g', { class: 'speedo-needle' });
  needle.append(node('line', {
    x1: CENTER.x, y1: CENTER.y + 6, x2: CENTER.x, y2: CENTER.y - RADIUS + 10,
  }));
  const hub = node('circle', { class: 'speedo-hub', cx: CENTER.x, cy: CENTER.y, r: 5 });
  svg.append(track, ticks, labels, needle, hub);
  dial.append(svg);

  // The number sits under the dial, not inside it, so the needle never runs
  // through the reading.
  const read = document.createElement('div');
  read.className = 'speedo-read';
  const speed = Object.assign(document.createElement('strong'), {
    className: 'speedo-mbps', textContent: '--',
  });
  const speedUnit = Object.assign(document.createElement('span'), {
    className: 'speedo-unit-text', textContent: 'Mb/s',
  });
  read.append(speed, speedUnit);

  const line = document.createElement('div');
  line.className = 'speedo-line';
  line.append(
    Object.assign(document.createElement('span'), { className: 'speedo-line-bar' }),
    Object.assign(document.createElement('span'), { className: 'speedo-line-text' }),
  );
  const lineBar = line.querySelector('.speedo-line-bar');
  const lineText = line.querySelector('.speedo-line-text');

  const foot = document.createElement('div');
  foot.className = 'speedo-foot';
  const fuel = document.createElement('div');
  fuel.className = 'speedo-fuel';
  const fuelLabel = Object.assign(document.createElement('span'), {
    className: 'speedo-fuel-label', textContent: 'time left',
  });
  const eta = Object.assign(document.createElement('strong'), {
    className: 'speedo-eta', textContent: '--:--',
  });
  const fuelTrack = Object.assign(document.createElement('span'), { className: 'speedo-fuel-track' });
  const fuelFill = Object.assign(document.createElement('span'), { className: 'speedo-fuel-fill' });
  fuelTrack.append(fuelFill);
  fuel.append(fuelLabel, eta, fuelTrack);
  foot.append(fuel);

  const meta = document.createElement('div');
  meta.className = 'speedo-meta';
  const bytesEl = Object.assign(document.createElement('span'), { className: 'speedo-bytes' });
  const pctEl = Object.assign(document.createElement('span'), { className: 'speedo-pct' });
  const linkEl = Object.assign(document.createElement('span'), { className: 'speedo-link' });
  meta.append(bytesEl, pctEl, linkEl);

  root.append(dial, read, line, foot, meta);

  let scale = 100;
  let fuelMax = 0;
  let shownSpeed = null;
  let done = false;

  function drawScale() {
    ticks.replaceChildren();
    labels.replaceChildren();
    for (let i = 0; i <= 4; i++) {
      const ratio = i / 4;
      const outer = point(ratio, RADIUS);
      const inner = point(ratio, RADIUS - (i % 2 ? 5 : 8));
      ticks.append(node('line', {
        class: 'speedo-tick',
        x1: inner.x.toFixed(2), y1: inner.y.toFixed(2),
        x2: outer.x.toFixed(2), y2: outer.y.toFixed(2),
      }));
      const at = point(ratio, RADIUS + 12);
      labels.append(node('text', {
        class: 'speedo-scale-label',
        x: at.x.toFixed(2),
        y: (at.y + 3).toFixed(2),
        'text-anchor': 'middle',
      }, String(Math.round(scale * ratio))));
    }
  }

  function setNeedle(mbps) {
    const ratio = shownSpeed === null ? 0 : Math.min(1, shownSpeed / scale);
    needle.style.transform = `rotate(${(-90 + ratio * 180).toFixed(2)}deg)`;
    speed.textContent = mbps === null ? '--' : (mbps < 10 ? mbps.toFixed(1) : String(Math.round(mbps)));
    dial.classList.toggle('is-idle', mbps === null && !done);
    root.classList.toggle('is-idle', mbps === null && !done);
  }

  drawScale();
  setNeedle(null);

  return {
    /** mbps: smoothed megabits per second, or null before there are enough samples. */
    setSpeed(mbps) {
      if (mbps !== null && Number.isFinite(mbps)) {
        shownSpeed = Math.max(0, mbps);
        const next = SCALES.find((value) => value >= shownSpeed);
        if (next && next > scale) {
          scale = next;
          drawScale();
        }
      } else {
        shownSpeed = null;
      }
      setNeedle(shownSpeed);
    },
    /** seconds: estimated time left, or null while it cannot be estimated. */
    setEta(seconds) {
      const ok = Number.isFinite(seconds) && seconds >= 0;
      eta.textContent = ok ? formatEta(seconds) : '--:--';
      if (ok && !fuelMax) fuelMax = Math.max(1, seconds);
      const ratio = ok && fuelMax ? Math.min(1, seconds / fuelMax) : 0;
      fuelFill.style.transform = `scaleX(${ratio.toFixed(3)})`;
      foot.classList.toggle('is-idle', !ok);
    },
    setBytes(sent, total) {
      const pct = total ? Math.min(100, Math.floor((sent / total) * 100)) : 0;
      bytesEl.textContent = `${formatBytes(sent)} / ${formatBytes(total)}`;
      pctEl.textContent = total ? `${pct}%` : '';
      lineBar.style.setProperty('--p', String(total ? sent / total : 0));
      lineText.textContent = total ? `${formatBytes(sent)} / ${formatBytes(total)} · ${pct}%` : '';
    },
    setLink(label) {
      linkEl.textContent = label || '';
    },
    setCompact(compact) {
      root.classList.toggle('compact', Boolean(compact));
    },
    setDone() {
      done = true;
      dial.classList.remove('is-idle');
      this.setEta(0);
    },
    reset() {
      done = false;
      fuelMax = 0;
      this.setSpeed(null);
      this.setEta(null);
      this.setBytes(0, 0);
      this.setLink('');
    },
  };
}
