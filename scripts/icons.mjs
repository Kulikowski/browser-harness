// Draws the toolbar icon at each size Chrome asks for, as real PNGs (no image tools needed).
// The mark: a sculpted slate-obsidian tile, a crisp prompt chevron, and a cobalt cursor pill.
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function distToRoundedRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx,
    dy = v - cy;
  const outside = Math.hypot(dx, dy);
  const inside = Math.max(
    Math.abs(u - (x0 + x1) / 2) - (x1 - x0) / 2 + r,
    Math.abs(v - (y0 + y1) / 2) - (y1 - y0) / 2 + r
  );
  return outside > 0 ? outside - r : inside - r;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function shade(u, v) {
  const pad = 0.04;
  const tileDist = distToRoundedRect(u, v, pad, pad, 1 - pad, 1 - pad, 0.23);
  if (tileDist > 0) return [0, 0, 0, 0];

  // Subtle vertical obsidian-slate gradient with a smooth 1px-style top rim catchlight.
  let bg = mix([32, 40, 56], [14, 17, 25], v);
  const rim = Math.max(0, 1 - Math.abs(tileDist + 0.012) / 0.014) * Math.max(0, 1 - v / 0.45);
  bg = mix(bg, [110, 130, 168], rim * 0.4);

  // Prompt chevron `>`
  const stroke = 0.072;
  const chevron = Math.min(distToSegment(u, v, 0.26, 0.31, 0.46, 0.5), distToSegment(u, v, 0.46, 0.5, 0.26, 0.69));
  if (chevron < stroke) return [246, 248, 252, 255];

  // Luminous cobalt cursor pill
  const pillDist = distToRoundedRect(u, v, 0.53, 0.59, 0.77, 0.71, 0.055);
  if (pillDist <= 0) {
    const blue = mix([96, 165, 250], [37, 99, 235], (v - 0.59) / 0.12);
    return [...blue, 255];
  }

  return [...bg, 255];
}

export function iconPng(size) {
  const samples = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const p = shade((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          acc = [acc[0] + p[0] * p[3], acc[1] + p[1] * p[3], acc[2] + p[2] * p[3], acc[3] + p[3]];
        }
      const a = acc[3] / (samples * samples);
      const o = 1 + x * 4;
      row[o] = acc[3] ? Math.round(acc[0] / acc[3]) : 0;
      row[o + 1] = acc[3] ? Math.round(acc[1] / acc[3]) : 0;
      row[o + 2] = acc[3] ? Math.round(acc[2] / acc[3]) : 0;
      row[o + 3] = Math.round(a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
