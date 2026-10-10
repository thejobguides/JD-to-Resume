// Generates the toolbar/store icons (indigo rounded square with a white check) without image dependencies.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const distToSegment = (px, py, ax, ay, bx, by) => {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
};

for (const size of [16, 32, 48, 128]) {
  const rows = [];
  const r = size * 0.22;
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // rounded-square mask
      const dx = Math.max(Math.abs(x + 0.5 - size / 2) - (size / 2 - r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - size / 2) - (size / 2 - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      const check = Math.min(distToSegment(u, v, 0.27, 0.52, 0.44, 0.69), distToSegment(u, v, 0.44, 0.69, 0.75, 0.33)) < 0.075;
      if (!inside) row.push(0, 0, 0, 0);
      else if (check) row.push(255, 255, 255, 255);
      else row.push(79, 70, 229, 255);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(new URL(`../public/icons/icon-${size}.png`, import.meta.url), png);
}
console.log('icons written');
