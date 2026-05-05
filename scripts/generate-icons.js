// scripts/generate-icons.js
// Creates minimal valid PNG icons for the extension without any external packages.
// Uses Node.js built-in `zlib` to handle the PNG DEFLATE compression requirement.
//
// Run once: node scripts/generate-icons.js

const fs    = require('fs');
const path  = require('path');
const zlib  = require('zlib');

const SIZES = [16, 48, 128];

// Target colour: a vivid cyan-blue that reads well as an icon.
// RGBA: 52, 152, 219, 255  (#3498DB)
const R = 52, G = 152, B = 219, A = 255;

function generatePNG(size) {
  // ── Build raw pixel data (filter-byte + RGBA per row) ──────────────────
  // PNG stores one filter-type byte (0x00 = None) before each scanline.
  const scanline    = 1 + size * 4;   // filter byte + size pixels × 4 channels
  const rawData     = Buffer.alloc(size * scanline);

  for (let y = 0; y < size; y++) {
    const rowOff = y * scanline;
    rawData[rowOff] = 0;  // filter type: None

    for (let x = 0; x < size; x++) {
      const off = rowOff + 1 + x * 4;

      // Draw a simple rounded-rect icon:
      //  - dark background inside a circular mask
      //  - accent colour fill
      const cx = size / 2, cy = size / 2, r = size * 0.45;
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < r) {
        // Inside circle: play-button triangle accent
        const bx = (x / size - 0.25), by = (y / size - 0.5);
        const inTriangle = bx > 0 && Math.abs(by) < bx * 0.8 && bx < 0.55;
        if (inTriangle) {
          // White triangle
          rawData[off]     = 255;
          rawData[off + 1] = 255;
          rawData[off + 2] = 255;
          rawData[off + 3] = A;
        } else {
          // Circle fill: accent colour
          rawData[off]     = R;
          rawData[off + 1] = G;
          rawData[off + 2] = B;
          rawData[off + 3] = A;
        }
      } else {
        // Outside circle: transparent
        rawData[off]     = 0;
        rawData[off + 1] = 0;
        rawData[off + 2] = 0;
        rawData[off + 3] = 0;
      }
    }
  }

  // ── Compress with DEFLATE (zlib wrapping as required by PNG) ───────────
  const compressed = zlib.deflateSync(rawData);

  // ── Build PNG binary ───────────────────────────────────────────────────
  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const len       = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const payload = Buffer.concat([typeBytes, data]);

    // CRC32 over type + data
    let crc = 0xFFFFFFFF;
    for (const b of payload) {
      crc ^= b;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
      }
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc, 0);

    return Buffer.concat([len, payload, crcBuf]);
  }

  const sig  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = (function() {
    const d = Buffer.alloc(13);
    d.writeUInt32BE(size, 0);  // width
    d.writeUInt32BE(size, 4);  // height
    d[8]  = 8;  // bit depth
    d[9]  = 6;  // color type: RGBA
    d[10] = 0;  // compression
    d[11] = 0;  // filter
    d[12] = 0;  // interlace
    return chunk('IHDR', d);
  }());

  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ── Write icons ───────────────────────────────────────────────────────────

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

for (const size of SIZES) {
  const png  = generatePNG(size);
  const dest = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(dest, png);
  console.log(`Written ${dest} (${png.length} bytes)`);
}

console.log('Icons generated successfully.');
