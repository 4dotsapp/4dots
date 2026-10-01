// Liquid-glass refraction. Chromium can run SVG filters inside backdrop-filter,
// so there we bend the backdrop along each element's rounded edge with a
// generated displacement map. Other browsers keep the frosted-glass styling.

const SVG_NS = 'http://www.w3.org/2000/svg';
const supported = Boolean(navigator.userAgentData?.brands?.some((b) => b.brand === 'Chromium'))
  && CSS.supports('backdrop-filter', 'url(#x)');
let serial = 0;

function svg(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/**
 * Displacement map for a rounded rectangle: neutral grey in the middle, and within
 * `bezel` px of the edge it samples from beyond the outline, so the rim wraps the
 * background around itself like the edge of a glass rod.
 */
function displacementMap(width, height, radius, bezel) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const r = Math.min(radius, width / 2, height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2;
      const py = y + 0.5 - height / 2;
      const qx = Math.abs(px) - (width / 2 - r);
      const qy = Math.abs(py) - (height / 2 - r);
      let nx = 0;
      let ny = 0;
      let edge;
      if (qx > 0 && qy > 0) {
        const len = Math.hypot(qx, qy) || 1;
        edge = r - len;
        nx = qx / len;
        ny = qy / len;
      } else if (qx > qy) {
        edge = r - qx;
        nx = 1;
      } else {
        edge = r - qy;
        ny = 1;
      }
      const t = Math.max(0, 1 - Math.max(0, edge) / bezel);
      const k = t * t * (3 - 2 * t); // smoothstep: strongest right at the rim
      const i = (y * width + x) * 4;
      image.data[i] = 128 + Math.sign(px) * nx * k * 127;
      image.data[i + 1] = 128 + Math.sign(py) * ny * k * 127;
      image.data[i + 2] = 128;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL();
}

export function lens(el, { bezel = 14, scale = 30, blur = 1.5, saturate = 1.8 } = {}) {
  if (!supported) return;
  const id = `lens-${serial++}`;
  const image = svg('feImage', { x: 0, y: 0, preserveAspectRatio: 'none', result: 'map' });
  const filter = svg('filter', {
    id,
    x: 0,
    y: 0,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  });
  filter.append(image, svg('feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'map',
    scale,
    xChannelSelector: 'R',
    yChannelSelector: 'G',
  }));
  document.getElementById('fx').append(filter);

  let size = '';
  let timer = 0;
  const update = () => {
    const width = Math.round(el.offsetWidth);
    const height = Math.round(el.offsetHeight);
    if (!width || !height || `${width}x${height}` === size) return;
    size = `${width}x${height}`;
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    for (const node of [filter, image]) {
      node.setAttribute('width', width);
      node.setAttribute('height', height);
    }
    image.setAttribute('href', displacementMap(width, height, radius, bezel));
    el.style.backdropFilter = `url(#${id}) blur(${blur}px) saturate(${saturate})`;
  };
  // A stale map would warp the wrong area, so drop the effect while resizing.
  new ResizeObserver(() => {
    if (size) el.style.removeProperty('backdrop-filter');
    size = '';
    clearTimeout(timer);
    timer = setTimeout(update, 120);
  }).observe(el);
}
