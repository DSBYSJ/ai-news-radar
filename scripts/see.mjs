#!/usr/bin/env node
/**
 * 截图文本化工具（see）—— 在没有图像查看能力时核对渲染结果
 *
 * 背景：DSH 的 read_image 工具在部分会话里会失效（报
 * "tool call aborted before dispatch"），此时无法直接看图。
 * 这个脚本把 PNG 解码成像素，再渲染成**文本**：亮度布局图 + 色彩分区图，
 * 可以在纯文本终端里判断布局、留白、对比度与配色是否失控。
 *
 * 用法：
 *   node scripts/see.mjs shot.png              # 亮度布局 + 色彩分区
 *   node scripts/see.mjs shot.png --color      # 只看色彩分区
 *   node scripts/see.mjs shot.png --cols=100   # 调整宽度
 *
 * 只依赖 node 内置模块（zlib），不需要任何图像库。
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

const RAMP = ' .:-=+*#%@'

/** 最小 PNG 解码器：仅支持 8bit、非隔行、RGBA/RGB/灰度 */
export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0, height = 0, bitDepth = 8, colorType = 6, interlace = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4
    const type = buf.toString('ascii', pos, pos + 4); pos += 4
    const data = buf.subarray(pos, pos + len); pos += len + 4
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('仅支持 8bit 非隔行 PNG')
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!ch) throw new Error('仅支持 RGBA / RGB / 灰度')
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * ch
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const lineStart = rp; rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= ch ? prev[x - ch] : 0
      let v = raw[lineStart + x]
      if (filter === 1) v = (v + a) & 255
      else if (filter === 2) v = (v + b) & 255
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
      cur[x] = v
    }
  }
  return { width, height, channels: ch, data: out }
}

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** 把图片降采样成 cols×rows 的色块（取块内均值） */
export function blocks(img, cols, rows) {
  const { width, height, channels, data } = img
  const out = []
  for (let ry = 0; ry < rows; ry++) {
    const row = []
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * width) / cols), x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / cols))
      const y0 = Math.floor((ry * height) / rows), y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows))
      let r = 0, g = 0, b = 0, n = 0
      const sx = Math.max(1, Math.floor((x1 - x0) / 4)), sy = Math.max(1, Math.floor((y1 - y0) / 4))
      for (let y = y0; y < y1; y += sy) for (let x = x0; x < x1; x += sx) {
        const i = (y * width + x) * channels
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
      }
      row.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
    }
    out.push(row)
  }
  return out
}

/** 亮度布局图：看结构、留白、对比（自动拉伸对比度，深色界面也看得清） */
export function ascii(img, cols = 100) {
  const rows = Math.max(8, Math.round((cols * img.height) / img.width / 2.1))
  const grid = blocks(img, cols, rows)
  const all = grid.flat().map(lum)
  const lo = Math.min(...all), span = Math.max(1, Math.max(...all) - lo)
  return grid.map(r => r.map(c =>
    RAMP[Math.min(RAMP.length - 1, Math.round(((lum(c) - lo) / span) * (RAMP.length - 1)))]
  ).join('')).join('\n')
}

/** 色彩分区图：看配色是否失控（多色相 = 花，单色相 = 克制） */
export function colorMap(img, cols = 72) {
  const rows = Math.max(6, Math.round((cols * img.height) / img.width / 2.1))
  return blocks(img, cols, rows).map(row => row.map(([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    const l = (mx + mn) / 2
    const sat = mx === mn ? 0 : (mx - mn) / (l > 127 ? 510 - mx - mn : mx + mn) * 100
    if (l < 26) return '.'
    if (sat < 18) return l > 200 ? 'W' : l > 120 ? 'w' : l > 60 ? 'g' : 'k'
    const d = mx - mn
    let h = 0
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
    else if (mx === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
    if (h < 25 || h >= 335) return 'R'
    if (h < 70) return 'Y'
    if (h < 160) return 'G'
    if (h < 200) return 'C'
    if (h < 260) return 'B'
    if (h < 300) return 'P'
    return 'M'
  }).join('')).join('\n')
}

// ---- CLI ----
const file = process.argv[2]
if (!file || file.startsWith('--')) {
  console.error('用法: node scripts/see.mjs <shot.png> [--color] [--cols=N]')
  process.exit(1)
}
const onlyColor = process.argv.includes('--color')
const colsArg = process.argv.find(a => a.startsWith('--cols='))
const cols = colsArg ? Number(colsArg.split('=')[1]) : 0

const img = decodePNG(readFileSync(file))
console.log(`# ${file}  ${img.width}x${img.height}  (${img.channels} 通道)`)
if (!onlyColor) {
  console.log('\n## 亮度布局（. 最暗 → @ 最亮）\n')
  console.log(ascii(img, cols || 100))
}
console.log('\n## 色彩分区（R红 Y黄 G绿 C青 B蓝 P紫 M洋红 W白 w浅灰 g中灰 k深灰 .近黑）\n')
console.log(colorMap(img, Math.round((cols || 100) * 0.74)))
