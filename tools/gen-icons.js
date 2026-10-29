// 纯 Node（zlib）生成 PWA 图标，无外部依赖
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  if (!crc32.t) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    crc32.t = t;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.t[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function makePNG(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const t = (x + y) / (2 * size);              // 对角线渐变 0..1
      const rr = 255;
      const gg = Math.round(122 + (111 - 122) * t); // #FF7A59 -> #FF6FA5
      const bb = Math.round(89 + (165 - 89) * t);
      const nx = x / size, ny = y / size;
      let drawn = false;
      const bx0 = 0.22, bx1 = 0.78, by0 = 0.30, by1 = 0.70, rad = 0.06;
      if (nx > bx0 && nx < bx1 && ny > by0 && ny < by1) {
        let inside = true;
        const corners = [[bx0 + rad, by0 + rad], [bx1 - rad, by0 + rad], [bx0 + rad, by1 - rad], [bx1 - rad, by1 - rad]];
        for (const [cx, cy] of corners) {
          const dx = nx - cx, dy = ny - cy;
          if ((nx < cx && ny < cy) || (nx > cx && ny < cy) || (nx < cx && ny > cy) || (nx > cx && ny > cy)) {
            if (dx * dx + dy * dy > rad * rad) inside = false;
          }
        }
        if (inside) {
          drawn = true;
          if (Math.abs(nx - 0.5) < 0.012) { px[i] = 0xEC; px[i + 1] = 0x6A; px[i + 2] = 0x4E; } // 书脊
          else {
            const pl = (ny - 0.36) % 0.08;
            if (pl < 0.02 && nx > bx0 + 0.05 && nx < bx1 - 0.05 && (nx < 0.49 || nx > 0.51)) {
              px[i] = 0xCB; px[i + 1] = 0xD5; px[i + 2] = 0xE6; // 书页线
            } else { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
          }
          px[i + 3] = 255;
        }
      }
      if (!drawn) { px[i] = rr; px[i + 1] = gg; px[i + 2] = bb; px[i + 3] = 255; }
    }
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const out = path.join(__dirname, '..', 'app', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), makePNG(192));
fs.writeFileSync(path.join(out, 'icon-512.png'), makePNG(512));
console.log('icons written to', out);
