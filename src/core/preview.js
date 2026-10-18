/**
 * 给"太大了没法当附件"的长截图做一份能过宿主校验的预览图。
 *
 * 为什么需要：DSH 的 attachments 服务对图片有硬门限（asar:363651-363667）
 *   - 准入（inspectMetadata → detectImage）：maxImagePixels 64e6、maxImageDimension **8192**
 *     → 一面超过 8192px 的 PNG 直接抛 AttachmentError，附件根本发不出去；
 *   - 归一化（prepareImageFile → normalizeImage）：maxPixels 4e6、maxDimension 8192、maxBytes 4e6，
 *     超了就要调 sharp 重编码（可能不可用/更慢）。
 * 而"整页长截图"很容易 13000px 高（拼多多首页 390x13046 就是），所以宿主侧必须自己先缩一份。
 * 原图仍然完整落在截图目录里，附件只是给你（模型）看的缩略预览。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { decodePng, encodePng, isPng } from './png.js';

export const PREVIEW_LIMITS = {
  maxDimension: 8000, // 比宿主 8192 留点余量
  maxPixels: 3.4e6, // 比宿主归一化门限 4e6 留点余量（避免触发 sharp 重编码）
  maxBytes: 3.4e6, // 同上（4e6）
};

/** 面积平均降采样（比最近邻干净得多，长图缩略后文字/图块不会锯齿乱跳） */
function boxDownscale(img, tw, th) {
  const { width: sw, height: sh, data: src } = img;
  const out = Buffer.alloc(tw * th * 4);
  const xRatio = sw / tw;
  const yRatio = sh / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((ty + 1) * yRatio)));
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((tx + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        let idx = (y * sw + x0) * 4;
        for (let x = x0; x < x1; x++, idx += 4) {
          r += src[idx];
          g += src[idx + 1];
          b += src[idx + 2];
          a += src[idx + 3];
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: tw, height: th, channels: 4, data: out };
}

/** 长截图是否"大到宿主一定收不下"（一面 > 8192px 或像素数超准入上限） */
export function needsPreview(size) {
  if (!size) return false;
  return size.width > 8192 || size.height > 8192 || size.width * size.height > 60e6;
}

/**
 * 生成预览 PNG。
 * @param {string|Buffer} src 原图路径或 PNG 字节
 * @param {string} dstPath 预览输出路径（建议与原图同目录、`-preview.png` 结尾）
 * @param {object} [limits]
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,scale:number,attempts:number}>}
 */
export async function makePreviewPng(src, dstPath, limits = {}) {
  const cfg = { ...PREVIEW_LIMITS, ...limits };
  const buf = Buffer.isBuffer(src) ? src : await fsp.readFile(src);
  if (!isPng(buf)) throw new Error('预览只支持 PNG 输入');
  const img = decodePng(buf);
  let scale = Math.min(
    1,
    Math.sqrt(cfg.maxPixels / (img.width * img.height)),
    cfg.maxDimension / Math.max(img.width, img.height),
  );
  let attempts = 0;
  let out;
  // 面积估算可能不准（压缩率随内容变化），编出来还是太大就再缩一点，最多三次
  for (let i = 0; i < 3; i++) {
    attempts++;
    const tw = Math.max(1, Math.round(img.width * scale));
    const th = Math.max(1, Math.round(img.height * scale));
    out = encodePng(boxDownscale(img, tw, th));
    if (out.length <= cfg.maxBytes || (tw <= 8 && th <= 8)) break;
    scale *= Math.sqrt(cfg.maxBytes / out.length) * 0.95;
  }
  await fsp.mkdir(path.dirname(dstPath), { recursive: true });
  await fsp.writeFile(dstPath, out);
  const tw = Math.max(1, Math.round(img.width * scale));
  const th = Math.max(1, Math.round(img.height * scale));
  return { path: dstPath, width: tw, height: th, bytes: out.length, scale, attempts };
}
