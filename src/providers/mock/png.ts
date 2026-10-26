import zlib from "node:zlib";

// 一个最小的 PNG 编码器。
//
// 为什么要自己写而不引 sharp / canvas：
//   1. sharp 带原生二进制（约 30MB，还要分平台）；这个 Mock 只需要产出
//      纯色渐变的占位图，不值得为它增加安装负担。
//   2. 顺便把「一个 PNG 文件到底由什么组成」讲清楚 —— 理解了它，
//      以后排查「图片能存但浏览器显示不出来」这类问题会快很多。
//
// PNG 结构（全部用大端序）：
//   89 50 4E 47 0D 0A 1A 0A   ← 8 字节魔数，用来校验「这确实是个 PNG」
//   [长度 4][类型 4][数据 N][CRC 4]   ← 一个 chunk
//   IHDR（图像头）→ IDAT（压缩后的像素）→ IEND（结束）
//
// 最容易错的两处：
//   - 每个 chunk 的 CRC32 是对「类型 + 数据」算的，不含长度字段
//   - IDAT 里的原始数据每条扫描线前面要加一个 filter 字节（0 表示不过滤）

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer) {
  if (!crcTable) crcTable = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);

  return Buffer.concat([length, typeAndData, crc]);
}

/** 把 RGB 像素数组编码成 PNG */
export function encodePng(width: number, height: number, rgb: Uint8Array) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 位深 8
  ihdr.writeUInt8(2, 9); // 颜色类型 2 = 真彩色 RGB
  ihdr.writeUInt8(0, 10); // 压缩方法
  ihdr.writeUInt8(0, 11); // 过滤方法
  ihdr.writeUInt8(0, 12); // 不隔行

  // 每条扫描线前补一个 filter 字节
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1
    );
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 下面是「画一张占位图」的部分 ----------

/** 把任意字符串稳定地映射成 0~1 的数，保证同一个 prompt 每次出同样的图 */
function hash01(s: string, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

export interface PlaceholderOptions {
  width?: number;
  height?: number;
  /** 决定配色，通常传 prompt —— 不同提示词出不同颜色的图，方便一眼分辨 */
  seed: string;
  /**
   * 0~1 的时间相位，用来让同一张图动起来。
   * 生成视频时逐帧递增它，高光带会缓慢扫过画面、色调也会轻微漂移，
   * 这样多帧编出来的视频才看得出"在动"，而不是一张静态图循环。
   */
  phase?: number;
}

/**
 * 生成一张渐变占位图。
 * 没有文字：画字需要字体文件，为了一个 Mock 引字体不值得。
 * 用「颜色随 prompt 变化」来替代标注 —— 调试时看颜色就知道是不是同一个 prompt。
 */
export function renderPlaceholderPng({
  width = 768,
  height = 432,
  seed,
  phase = 0,
}: PlaceholderOptions) {
  const hueA = (hash01(seed) * 360 + phase * 40) % 360;
  const hueB = (hueA + 60 + hash01(seed, 7) * 120) % 360;
  const top = hslToRgb(hueA, 0.55, 0.22);
  const bottom = hslToRgb(hueB, 0.6, 0.55);

  // 斜向高光的位置由 seed 决定，并随 phase 缓慢扫过画面
  const streakX = (0.25 + hash01(seed, 13) * 0.5 + phase * 0.6) % 1.2 - 0.2;
  const streakW = 0.06 + hash01(seed, 21) * 0.06;

  const rgb = new Uint8Array(width * height * 3);

  for (let y = 0; y < height; y++) {
    const ty = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const tx = x / (width - 1);

      // 基础垂直渐变
      let r = top[0] + (bottom[0] - top[0]) * ty;
      let g = top[1] + (bottom[1] - top[1]) * ty;
      let b = top[2] + (bottom[2] - top[2]) * ty;

      // 斜向高光带：|x - (streakX + ty*0.3)| < streakW 时提亮
      const d = Math.abs(tx - (streakX + ty * 0.28));
      if (d < streakW) {
        const k = (1 - d / streakW) ** 2 * 90;
        r += k;
        g += k;
        b += k;
      }

      // 四角压暗，做出一点电影感
      const vx = (tx - 0.5) * 2;
      const vy = (ty - 0.5) * 2;
      const vignette = 1 - 0.35 * Math.min(1, (vx * vx + vy * vy) / 1.6);
      r *= vignette;
      g *= vignette;
      b *= vignette;

      const i = (y * width + x) * 3;
      rgb[i] = Math.max(0, Math.min(255, Math.round(r)));
      rgb[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgb[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  return encodePng(width, height, rgb);
}
