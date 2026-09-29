const PLANE_PATH =
  'M32 3C34.2 3 35.5 5.5 35.5 9L35.5 23L60 36L60 40.5L35.5 33.5L35.5 49L42 54L42 57.5L32 55' +
  'L22 57.5L22 54L28.5 49L28.5 33.5L4 40.5L4 36L28.5 23L28.5 9C28.5 5.5 29.8 3 32 3Z';

const ICONS = [
  ['plane', '#ffc30b', '#5e4700'],
  ['plane-selected', '#ff3b30', '#5c0f0a'],
];

function renderPlane(fill, stroke, pixelRatio) {
  const size = 64 * pixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.scale(pixelRatio, pixelRatio);
  const path = new Path2D(PLANE_PATH);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = stroke;
  ctx.stroke(path);
  ctx.fillStyle = fill;
  ctx.fill(path);
  return ctx.getImageData(0, 0, size, size);
}

export function addAircraftImages(map) {
  const pixelRatio = 2;
  for (const [name, fill, stroke] of ICONS) {
    if (!map.hasImage(name)) map.addImage(name, renderPlane(fill, stroke, pixelRatio), { pixelRatio });
  }
}

export const PLANE_SVG_PATH = PLANE_PATH;
