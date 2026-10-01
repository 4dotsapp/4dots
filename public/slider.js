// Liquid selection pill for segmented controls. The pill runs on springs, so a
// press makes it swell, a drag pulls it along under the finger (stretching with
// speed and resisting past the ends), and a release lets it settle on the
// nearest option with a little overshoot. Taps and keys keep working as before.
import { motionBlur, prefersReducedMotion } from './motion.js';

const DRAG_THRESHOLD = 4;
const SWELL = 1.1;
const FLING = 0.08; // seconds of momentum carried into the choice on release
const STEP = 1 / 240;

class Spring {
  constructor(value, stiffness, damping, precision) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
    this.precision = precision;
  }

  step(dt) {
    const force = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
    this.velocity += force * dt;
    this.value += this.velocity * dt;
  }

  get settled() {
    return Math.abs(this.target - this.value) < this.precision && Math.abs(this.velocity) < this.precision * 10;
  }

  snap() {
    this.value = this.target;
    this.velocity = 0;
  }
}

/** Soft limit: the further past the end, the harder it pulls back. */
const rubber = (distance) => 14 * (1 - Math.exp(-distance / 40));

export function liquidSlider(track, thumb, items, onSelect, initial = 0) {
  const x = new Spring(0, 520, 28, 0.2);
  const width = new Spring(0, 520, 28, 0.2);
  const swell = new Spring(1, 700, 22, 0.001);
  const springs = [x, width, swell];
  let index = initial;
  let frame = 0;
  let last = 0;
  let blur = null;
  let press = null;
  let swallowClicksUntil = 0;

  const slot = (i) => ({ left: items[i].offsetLeft, width: items[i].offsetWidth });
  const centers = () => items.map((_, i) => slot(i).left + slot(i).width / 2);

  function nearest(center) {
    let best = 0;
    centers().forEach((c, i, all) => {
      if (Math.abs(c - center) < Math.abs(all[best] - center)) best = i;
    });
    return best;
  }

  /** Options can differ in width, so the pill blends between its neighbours' widths. */
  function widthAt(center) {
    const all = centers();
    if (center <= all[0]) return slot(0).width;
    for (let i = 1; i < all.length; i++) {
      if (center <= all[i]) {
        const t = (center - all[i - 1]) / (all[i] - all[i - 1]);
        return slot(i - 1).width + (slot(i).width - slot(i - 1).width) * t;
      }
    }
    return slot(items.length - 1).width;
  }

  function render() {
    const stretch = Math.min(0.16, Math.abs(x.velocity) / 6000);
    thumb.style.width = `${width.value}px`;
    thumb.style.transform = `translate3d(${x.value}px, 0, 0) scale(${swell.value * (1 + stretch)}, ${swell.value * (1 - stretch / 2)})`;
  }

  function tick(now) {
    // Small fixed steps keep the bounce the same at any frame rate.
    const steps = Math.ceil(Math.min(0.05, (now - last) / 1000) / STEP);
    last = now;
    for (let i = 0; i < steps; i++) for (const spring of springs) spring.step(STEP);
    render();
    blur.track(x.value);
    if (!press && springs.every((spring) => spring.settled)) {
      for (const spring of springs) spring.snap();
      render();
      blur.release();
      blur = null;
      frame = 0;
      return;
    }
    frame = requestAnimationFrame(tick);
  }

  function animate() {
    if (prefersReducedMotion()) {
      for (const spring of springs) spring.snap();
      render();
      return;
    }
    if (frame) return;
    blur = motionBlur(thumb, 'x', { strength: 0.35, max: 6 });
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function select(i, { instant = false } = {}) {
    index = i;
    if (!track.offsetWidth) return;
    x.target = slot(i).left;
    width.target = slot(i).width;
    if (instant) {
      x.snap();
      width.snap();
      render();
    } else {
      animate();
    }
  }

  function light(i) {
    items.forEach((item, j) => item.classList.toggle('lit', j === i));
  }

  function onMove(event) {
    if (event.pointerId !== press.id) return;
    if (!press.dragging) {
      if (Math.abs(event.clientX - press.startX) < DRAG_THRESHOLD) return;
      press.dragging = true;
      track.classList.add('dragging');
    }
    const center = event.clientX - press.origin - press.grab;
    const w = widthAt(center);
    const min = slot(0).left;
    const max = slot(items.length - 1).left + slot(items.length - 1).width;
    let left = center - w / 2;
    if (left < min) left = min - rubber(min - left);
    if (left + w > max) left = max - w + rubber(left + w - max);
    x.target = left;
    width.target = w;
    light(nearest(left + w / 2));
    animate();
  }

  function finish(event, cancelled) {
    if (event.pointerId !== press.id) return;
    const { dragging } = press;
    press = null;
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    removeEventListener('pointercancel', onCancel);
    swell.target = 1;
    thumb.classList.remove('pressed');
    track.classList.remove('dragging');
    light(-1);
    if (dragging) {
      swallowClicksUntil = performance.now() + 400;
      const next = cancelled ? index : nearest(x.value + width.value / 2 + x.velocity * FLING);
      if (next === index) select(index);
      else onSelect(next);
    }
    animate();
  }

  const onUp = (event) => finish(event, false);
  const onCancel = (event) => finish(event, true);

  track.addEventListener('pointerdown', (event) => {
    if (press || event.button !== 0) return;
    if (event.pointerType === 'mouse') event.preventDefault();
    const origin = track.getBoundingClientRect().left + track.clientLeft;
    const at = event.clientX - origin;
    const onThumb = at >= x.value && at <= x.value + width.value;
    press = {
      id: event.pointerId,
      startX: event.clientX,
      origin,
      grab: onThumb ? at - (x.value + width.value / 2) : 0,
      dragging: false,
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onCancel);
    swell.target = SWELL;
    thumb.classList.add('pressed');
    animate();
  });

  // A drag ends with a click on whatever is under the pointer; the drag already chose.
  track.addEventListener('click', (event) => {
    if (performance.now() < swallowClicksUntil) {
      event.stopPropagation();
      event.preventDefault();
      swallowClicksUntil = 0;
    }
  }, true);

  new ResizeObserver(() => {
    if (!press) select(index, { instant: true });
  }).observe(track);

  select(index, { instant: true });
  return { select };
}
