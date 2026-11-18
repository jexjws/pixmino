import zlib from 'node:zlib';

// Minimal decoder for the RGBA/RGB 8-bit non-interlaced PNGs Playwright produces,
// so the regression test can assert on what the user actually sees.
export function decodePng(buffer) {
  if (buffer.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error('not a PNG');
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || ![2, 6].includes(colorType) || data[12] !== 0) throw new Error('unsupported PNG format');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toUpLeft = Math.abs(estimate - upLeft);
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// Fraction of sampled pixels that are visibly lit rather than the page's near-black backdrop.
export function litRatio(buffer, { stride = 4, threshold = 60 } = {}) {
  const { width, height, channels, pixels } = decodePng(buffer);
  let lit = 0, total = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const index = (y * width + x) * channels;
      total += 1;
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] > threshold) lit += 1;
    }
  }
  return { ratio: lit / total, width, height };
}
