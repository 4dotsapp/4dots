// Small animation kit: rAF tweens plus speed-driven directional motion blur.

const SVG_NS = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const prefersReducedMotion = () => reducedMotion.matches;

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
  const filter = acquireFilter();
  const css = `url(#${filter.id})`;
  el.style.filter = css;
  let lastPos = null;
  let lastTime = 0;
  return {
    track(pos) {
      const now = performance.now();
      if (lastPos !== null && now > lastTime) {
        const perFrame = (Math.abs(pos - lastPos) / (now - lastTime)) * 16.7;
        const amount = Math.min(max, perFrame * strength).toFixed(2);
        filter.blur.setAttribute('stdDeviation', axis === 'x' ? `${amount} 0` : `0 ${amount}`);
      }
      lastPos = pos;
      lastTime = now;
    },
    release() {
      // Browsers serialize it back as url("#id"), so match on the id. Another
      // animation may have claimed the element since; leave its filter alone.
      if (el.style.filter.includes(filter.id + '"') || el.style.filter.includes(filter.id + ')')) {
        el.style.removeProperty('filter');
      }
      filter.blur.setAttribute('stdDeviation', '0');
      pool.push(filter);
    },
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
    const settle = (p) => (p < 0.7 ? 0 : Math.sin((Math.PI * (p - 0.7)) / 0.3) ** 2);
    return tween(950 + i * 170, (_, p) => {
      const pos = target * ease.outQuart(p) + 0.22 * settle(p);
      strip.style.transform = `translate3d(0, ${(-pos / cells) * 100}%, 0)`;
      blur.track(pos * reel.clientHeight);
    }, ease.linear).then(() => blur.release());
  }));
}
