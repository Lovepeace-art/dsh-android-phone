/**
 * 极简 PNG 编解码（纯 Node，只用 zlib）
 *
 * 为什么自己写：长截图的"逐帧拼接"需要在 Node 侧拿到像素、做运动估计、
 * 再把结果写回 PNG。为了不引入 sharp/canvas 这类原生依赖（装不上、体积大、
 * 还要处理平台差异），这里只实现截图会用到的子集：
 *   - 位深 8、非隔行；
 *   - colorType 6(RGBA) / 2(RGB) / 4(灰度+alpha) / 0(灰度)；
 *   - 解码后一律转成 RGBA（4 通道），编码只写 RGBA。
 * Chromium 的 `page.screenshot({type:'png'})` 输出正好落在支持范围内。
 */
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIG);
}

/**
 * 只读 IHDR 拿宽高（不解码全图）：返回 { width, height, bitDepth, colorType, bytes } 或 null
 * 用途：快速判断 adb screencap 出来的字节到底是完整 PNG 还是被污染/截断。
 */
export function pngSize(buf) {
  if (!isPng(buf) || buf.length < 33) return null;
  const bitDepth = buf[24];
  const colorType = buf[25];
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 40000 || height > 40000) return null;
  return { width, height, bitDepth, colorType, bytes: buf.length };
}

/**
 * 解码 PNG → { width, height, channels: 4, data: Buffer(RGBA) }
 * 只支持位深 8 / 非隔行（截图输出满足）。
 */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('decodePng: not a PNG (bad signature)');
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const start = off + 8;
    const end = start + len;
    if (end + 4 > buf.length) throw new Error(`decodePng: truncated chunk ${type}`);
    if (type === 'IHDR') {
      ihdr = {
        width: buf.readUInt32BE(start),
        height: buf.readUInt32BE(start + 4),
        bitDepth: buf[start + 8],
        colorType: buf[start + 9],
        compression: buf[start + 10],
        filter: buf[start + 11],
        interlace: buf[start + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    off = end + 4;
  }
  if (!ihdr) throw new Error('decodePng: no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`decodePng: unsupported bitDepth ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error('decodePng: interlaced PNG not supported');
  const channels = CHANNELS_BY_COLOR_TYPE[ihdr.colorType];
  if (!channels) throw new Error(`decodePng: unsupported colorType ${ihdr.colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('decodePng: short IDAT data');

  // 逐行反过滤（PNG filter 0..4）
  const out = Buffer.allocUnsafe(stride * height + 1); // 第一行留一格给 prev，实际用 out+1
  const lines = out.subarray(1);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = lines.subarray(y * stride, (y + 1) * stride);
    const prev = y ? lines.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = row[x];
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`decodePng: bad filter type ${ft} at row ${y}`);
      }
      cur[x] = r & 0xff;
    }
  }

  if (channels === 4) return { width, height, channels: 4, data: lines };
  // 统一扩成 RGBA，后续拼接逻辑只需处理一种内存布局
  const rgba = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0, n = width * height; i < n; i++) {
    let r, g, b, a = 255;
    if (channels === 3) { r = lines[i * 3]; g = lines[i * 3 + 1]; b = lines[i * 3 + 2]; }
    else if (channels === 2) { r = g = b = lines[i * 2]; a = lines[i * 2 + 1]; }
    else { r = g = b = lines[i]; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, channels: 4, data: rgba };
}

/** 编码 RGBA 缓冲 → PNG Buffer（filter 全 0，够用且快） */
export function encodePng(img) {
  const { width, height, data } = img;
  const channels = img.channels ?? 4;
  const stride = width * channels;
  if (data.length < stride * height) throw new Error('encodePng: data too short');

  const raw = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : 0;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 从一张 RGBA 图里裁一段（按行）→ 新的 RGBA 图 */
export function cropRows(img, y0, y1) {
  const { width, data } = img;
  const h = Math.max(0, y1 - y0);
  const out = Buffer.allocUnsafe(width * h * 4);
  if (h) data.copy(out, 0, y0 * width * 4, y1 * width * 4);
  return { width, height: h, channels: 4, data: out };
}

/** 新建一张 RGBA 图（零填充 = 全透明黑） */
export function blankImage(width, height) {
  return { width, height, channels: 4, data: Buffer.alloc(width * height * 4) };
}
