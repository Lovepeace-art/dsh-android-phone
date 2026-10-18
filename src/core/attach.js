/**
 * 「把截图交给宿主 attachments 服务」的独立实现。
 *
 * 单独放一个文件的原因：这段逻辑踩过两个坑，需要有**不依赖 DSH 宿主**的回归测试
 * （`scripts/test-attach.mjs` / `scripts/test-preview.mjs`）。
 *
 * 坑 1：工具输出必须是「无损 JSON」。DSH 用 walkJsonValue 校验工具返回值，含 `undefined`
 *   的对象直接判非法（`tool "x" returned invalid output: value is not lossless JSON`），
 *   而 JSON.stringify 会静默丢掉 undefined —— 所以 HTTP 路径和假 ctx 测试都发现不了，
 *   只有真模型调用才炸。凡是直接透传宿主对象（ref）的地方都得先洗一遍。
 *
 * 坑 2：宿主 attachments 有准入门限（单面 ≤ 8192px、像素 ≤ 64e6、单图 ≤ 20MB），
 *   归一化又有更紧的预算（4e6 像素 / 4e6 字节）。整页长截图（如拼多多首页 390x13046）
 *   会被直接拒掉，所以宿主侧先自己缩一份预览（`src/mobile/preview.js`）再送。
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { pngSize } from './png.js';
import { needsPreview, makePreviewPng } from './preview.js';

/**
 * 把任意值洗成"无损 JSON"：丢掉 undefined / 函数 / Symbol / BigInt / 环，
 * 把 NaN / Infinity / -0 换成 null，Buffer 换成 {bytes}。
 */
export function jsonSafe(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : null;
  if (typeof value !== 'object') return undefined; // undefined / function / symbol / bigint -> 丢弃该字段
  if (Buffer.isBuffer(value)) return { bytes: value.length };
  if (seen.has(value)) return undefined; // 环：丢弃该分支而不是整个结果
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    out = value.map((item) => {
      const safe = jsonSafe(item, seen);
      return safe === undefined ? null : safe; // 数组里不能留洞，补 null
    });
  } else {
    out = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, seen);
      if (safe !== undefined) out[key] = safe;
    }
  }
  seen.delete(value);
  return out;
}

export function defaultPreviewPath(filePath) {
  return `${String(filePath).replace(/\.png$/i, '')}-preview.png`;
}

/**
 * 造一个 attachPng(filePath) -> 附件描述 | undefined 的函数。
 *
 * @param {object} opts
 * @param {() => any} opts.getService 惰性取 attachments 服务（插件 apply 时它可能还没就位）
 * @param {(info: {path: string, width: number, height: number, bytes: number, scale: number, original: any}) => void} [opts.onPreview]
 * @param {(msg: string) => void} [opts.warn]
 * @param {(filePath: string) => string} [opts.previewPathFor]
 */
export function createImageAttacher({ getService, onPreview, warn = () => {}, previewPathFor = defaultPreviewPath } = {}) {
  const describePreview = (pre, original) => ({
    path: pre.path,
    width: pre.width,
    height: pre.height,
    bytes: pre.bytes,
    scale: Number(pre.scale.toFixed(4)),
    original,
  });

  return async function attachPng(filePath) {
    if (typeof getService !== 'function') return undefined;
    const service = getService();
    if (!service?.saveImage) return undefined;
    try {
      const put = async (p) => {
        const data = await readFile(p);
        const ref = await service.saveImage({ data, mediaType: 'image/png', name: path.basename(p) });
        return { ref, bytes: data.length };
      };
      const previewPath = previewPathFor(filePath);
      const size = pngSize(await readFile(filePath));
      let preview;
      const buildPreview = async () => {
        const pre = await makePreviewPng(filePath, previewPath);
        preview = describePreview(pre, size);
        onPreview?.(preview);
        return preview;
      };
      // 长截图先自己缩一份，否则会被宿主的附件门限（单面 8192px）拒掉
      if (needsPreview(size)) await buildPreview();
      let saved;
      try {
        saved = await put(preview ? preview.path : filePath);
      } catch (error) {
        if (preview) throw error;
        // 没料到会被拒（宿主门限比我们以为的更紧）：缩一份再试一次
        await buildPreview();
        saved = await put(preview.path);
      }
      const { ref, bytes } = saved;
      const info = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType ?? 'image/png',
        bytes: ref.bytes ?? bytes,
      };
      // 只有宿主真的给了才带上：undefined 字段会让工具输出被判非法 JSON
      if (Number.isFinite(ref.width)) info.width = ref.width;
      if (Number.isFinite(ref.height)) info.height = ref.height;
      if (ref.name !== undefined) info.name = ref.name;
      if (preview) info.preview = preview;
      return info;
    } catch (error) {
      warn(`图片附件化失败: ${error?.message ?? error}`);
      return undefined;
    }
  };
}
