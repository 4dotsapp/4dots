// Small animation kit: rAF tweens plus speed-driven directional motion blur.

const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const prefersReducedMotion = () => reducedMotion.matches;

// Devices that can't keep up get a lighter mode: the background digits stop
// drifting and motion blur and edge refraction switch off, while the glass,
// slides and springs stay. It starts after two view changes in a row run below
// about 40 fps, and the device remembers it for a month.
const LITE_KEY = '4dots:lite';
const LITE_DAYS = 30;
let lite = false;
let strikes = 0;

function enableLite(since = Date.now()) {
  lite = true;
  document.documentElement.classList.add('lite');
  try {
    localStorage.setItem(LITE_KEY, String(since));
  } catch {}
}

try {
  const since = Number(localStorage.getItem(LITE_KEY));
  if (since && Date.now() - since < LITE_DAYS * 86_400_000) enableLite(since);
} catch {}

/** Judges how smoothly an animation ran from its frame timestamps. */
export function judgeFrames(times) {
  if (lite) return;
  const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const slow = gaps.length < 2 || gaps[gaps.length >> 1] > 25;
  strikes = slow ? strikes + 1 : 0;
  if (strikes >= 2) enableLite();
}

export const ease = {
  linear: (t) => t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  outQuart: (t) => 1 - (1 - t) ** 4,
  outQuint: (t) => 1 - (1 - t) ** 5,
  outBack: (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2,
};

/**
 * Runs onFrame(eased, progress) every frame for `duration` ms. Setting
 * `control.stopped` ends it early without another frame.
 */
export function tween(duration, onFrame, easing = ease.outCubic, control = {}) {
  return new Promise((resolve) => {
    if (prefersReducedMotion() || duration <= 0) {
      onFrame(1, 1);
      resolve();
      return;
    }
    const start = performance.now();
    const frame = (now) => {
      if (control.stopped) {
        resolve();
        return;
      }
      const progress = Math.min(1, (now - start) / duration);
      onFrame(easing(progress), progress);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// Each moving element borrows an SVG Gaussian blur from a pool and is blurred
// along its axis of travel in proportion to how fast it is moving.
const pool = [];
let serial = 0;

function acquireFilter() {
  if (pool.length) return pool.pop();
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.id = `motion-${serial++}`;
  for (const [name, value] of Object.entries({ x: '-50%', y: '-50%', width: '200%', height: '200%' })) {
    filter.setAttribute(name, value);
  }
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const blur = document.createElementNS(SVG_NS, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '0');
  filter.append(blur);
  document.getElementById('fx').append(filter);
  return { id: filter.id, blur };
}

export function motionBlur(el, axis, { strength = 0.5, max = 16 } = {}) {
  if (lite) return { track() {}, release() {} };
  const filter = acquireFilter();
  const css = `url(#${filter.id})`;
  // Browsers serialize it back as url("#id"), so match on the id. Another
  // animation may have claimed the element since; leave its filter alone then.
  const owns = () => el.style.filter.includes(filter.id + '"') || el.style.filter.includes(filter.id + ')');
  let lastPos = null;
  let lastTime = 0;
  let shown = 0;
  // Half-pixel steps, so the filter only changes when the blur visibly does. Below
  // half a pixel it comes off entirely, which saves the browser an offscreen pass.
  const show = (amount) => {
    const value = Math.round(amount * 2) / 2;
    if (value === shown) return;
    if (value) {
      filter.blur.setAttribute('stdDeviation', axis === 'x' ? `${value} 0` : `0 ${value}`);
      if (!shown) el.style.filter = css;
    } else if (owns()) {
      el.style.removeProperty('filter');
    }
    shown = value;
  };
  return {
    track(pos) {
      const now = performance.now();
      if (lastPos !== null && now > lastTime) {
        const perFrame = (Math.abs(pos - lastPos) / (now - lastTime)) * 16.7;
        show(Math.min(max, perFrame * strength));
      }
      lastPos = pos;
      lastTime = now;
    },
    release() {
      if (owns()) el.style.removeProperty('filter');
      filter.blur.setAttribute('stdDeviation', '0');
      pool.push(filter);
    },
  };
}

// The digits drifting behind the page make every frosted panel re-blur on each
// frame. While something in front animates they hold still, so that work goes to
// the animation instead. Holds nest; the drift resumes when the last one ends.
let holds = 0;

export function holdBackdrop() {
  holds++;
  document.documentElement.classList.add('hold-backdrop');
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holds === 0) document.documentElement.classList.remove('hold-backdrop');
  };
}

/**
 * Slot-machine reveal: every reel spins down to its digit with vertical motion
 * blur, landing one after another with a small overshoot.
 */
export function rollDigits(reels, code) {
  return Promise.all(reels.map((reel, i) => {
    const strip = reel.querySelector('.strip');
    const cells = strip.children.length;
    const target = cells - 10 + Number(code[i]);
    const blur = motionBlur(strip, 'y', { strength: 0.42, max: 22 });
    const release = holdBackdrop();
    const settle = (p) => (p < 0.7 ? 0 : Math.sin((Math.PI * (p - 0.7)) / 0.3) ** 2);
    return tween(950 + i * 170, (_, p) => {
      const pos = target * ease.outQuart(p) + 0.22 * settle(p);
      strip.style.transform = `translate3d(0, ${(-pos / cells) * 100}%, 0)`;
      blur.track(pos * reel.clientHeight);
    }, ease.linear).then(() => {
      blur.release();
      release();
    });
  }));
}
