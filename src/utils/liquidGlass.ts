/**
 * 液态玻璃折射（Liquid Glass refraction）
 * ------------------------------------------------------------------
 * 实现参考 shuding/liquid-glass（WWDC25 Liquid Glass 的纯 CSS/SVG 复刻）：
 *   https://github.com/shuding/liquid-glass
 *
 * 原理（这是"真折射"，不是描边模拟）：
 *   1. 用**圆角矩形 SDF**（有符号距离场）算每个像素到边界的距离；
 *   2. 只在离边界 band 像素以内产生位移 —— 中心区域的 t=0，完全不变形，
 *      这正是 Liquid Glass 的关键特征；
 *   3. 采样点朝中心收缩 k = strength * t → 边缘像被"拉"了一下，形成透镜弯折；
 *   4. 把 dx/dy 编码进一张 RGB 贴图（R=x 偏移，G=y 偏移），
 *      交给 feDisplacementMap 的 xChannelSelector=R / yChannelSelector=G；
 *   5. 通过 backdrop-filter: url(#id) 作用在元素的**背景**上。
 *
 * ⚠️ 踩过的坑：早前用 feTurbulence 当位移图，实测像素差异 0.0% —— 噪声是随机
 * 扰动，不产生透镜位移。必须是按 SDF 计算的定向位移图，且滤镜要
 * filterUnits="userSpaceOnUse"、区域覆盖整个元素。
 *
 * 性能：位移图只与**元素尺寸**有关，与内容无关，因此按尺寸缓存复用；
 * 大尺寸元素把贴图降采样（dpi<1）以压低生成耗时。
 */

export interface LiquidGlassOptions {
  /** 折射带宽度（px）：只有离边界这么近的区域才变形 */
  band?: number
  /** 折射强度：采样点朝中心收缩的比例上限 */
  strength?: number
}

interface FilterEntry {
  id: string
  scale: number
}

const cache = new Map<string, FilterEntry>()
let defs: SVGDefsElement | null = null
let seq = 0
const MAX_FILTERS = 40

const smoothStep = (a: number, b: number, t: number): number => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

/** 圆角矩形有符号距离场：内部为负，边界为 0，外部为正 */
function roundedRectSDF(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r
  const qy = Math.abs(py) - hh + r
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

function ensureDefs(): SVGDefsElement {
  if (defs && document.contains(defs)) return defs
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:-1'
  defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  svg.appendChild(defs)
  document.body.appendChild(svg)
  return defs
}

/** 生成（或复用）某个尺寸的折射滤镜，返回滤镜 id */
export function getRefractionFilter(
  width: number,
  height: number,
  radius: number,
  opts: LiquidGlassOptions = {},
): string {
  const band = opts.band ?? 20
  const strength = opts.strength ?? 0.32

  // 尺寸取整到 4px，避免每个像素差异都新建一张贴图
  const w = Math.max(8, Math.round(width / 4) * 4)
  const h = Math.max(8, Math.round(height / 4) * 4)
  const key = `${w}x${h}r${Math.round(radius)}b${band}s${strength}`
  const hit = cache.get(key)
  if (hit) return hit.id

  // 大元素降采样：贴图会被 feImage 拉伸回原尺寸，视觉差异很小
  const dpi = w * h > 260_000 ? 0.5 : 1
  const cw = Math.max(4, Math.round(w * dpi))
  const ch = Math.max(4, Math.round(h * dpi))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const data = new Uint8ClampedArray(cw * ch * 4)
  const raw = new Float32Array(cw * ch * 2)
  let maxScale = 0

  for (let i = 0, p = 0; i < data.length; i += 4, p += 2) {
    const x = (i / 4) % cw
    const y = Math.floor(i / 4 / cw)
    // 转到以元素中心为原点的像素坐标
    const px = x / dpi - w / 2
    const py = y / dpi - h / 2
    const d = roundedRectSDF(px, py, w / 2, h / 2, Math.min(radius, Math.min(w, h) / 2))
    // 只在边界内 band 范围产生位移；中心 t=0 → 不变形
    const t = smoothStep(-band, 0, d)
    const k = strength * t
    const nx = px * (1 - k) + w / 2
    const ny = py * (1 - k) + h / 2
    const dx = (nx - (x / dpi)) * dpi
    const dy = (ny - (y / dpi)) * dpi
    raw[p] = dx
    raw[p + 1] = dy
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    if (adx > maxScale) maxScale = adx
    if (ady > maxScale) maxScale = ady
  }

  const sc = Math.max(1e-6, maxScale * 0.5)
  for (let i = 0, p = 0; i < data.length; i += 4, p += 2) {
    data[i] = (raw[p] / sc) * 255 + 127.5
    data[i + 1] = (raw[p + 1] / sc) * 255 + 127.5
    data[i + 2] = 0
    data[i + 3] = 255
  }
  ctx.putImageData(new ImageData(data, cw, ch), 0, 0)

  // 缓存过多时清空重来（长时间会话 / 大量不同尺寸时兜底）
  if (cache.size >= MAX_FILTERS) clearRefractionFilters()

  const d = ensureDefs()
  const id = `lg-${++seq}`
  const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  filter.setAttribute('x', '0')
  filter.setAttribute('y', '0')
  filter.setAttribute('width', String(w))
  filter.setAttribute('height', String(h))

  const feImage = document.createElementNS('http://www.w3.org/2000/svg', 'feImage')
  feImage.setAttribute('id', `${id}-map`)
  feImage.setAttribute('width', String(w))
  feImage.setAttribute('height', String(h))
  feImage.setAttributeNS('http://www.w3.org/1999/xlink', 'href', canvas.toDataURL())

  const disp = document.createElementNS('http://www.w3.org/2000/svg', 'feDisplacementMap')
  disp.setAttribute('in', 'SourceGraphic')
  disp.setAttribute('in2', `${id}-map`)
  disp.setAttribute('xChannelSelector', 'R')
  disp.setAttribute('yChannelSelector', 'G')
  // scale 单位是滤镜用户空间 → 除以 dpi 换回 CSS 像素
  disp.setAttribute('scale', String(sc / dpi))

  filter.appendChild(feImage)
  filter.appendChild(disp)
  d.appendChild(filter)

  cache.set(key, { id, scale: sc / dpi })
  return id
}

export function clearRefractionFilters(): void {
  cache.clear()
  if (defs) defs.innerHTML = ''
}

/**
 * 把折射应用到页面上的玻璃元素。
 * 只处理有尺寸变化的元素（用 data-lg 记住上次的规格），避免重复设置样式。
 */
/** 参与液态玻璃的元素选择器（深色模式下生效，由 CSS 控制底色） */
export const LIQUID_SELECTOR = '.card, .seg, .status-bar, .glass'

export function applyRefraction(root: ParentNode = document.body): number {
  const nodes = root.querySelectorAll<HTMLElement>(LIQUID_SELECTOR)
  let applied = 0
  nodes.forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 40 || rect.height < 24) return
    const radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 16
    const id = getRefractionFilter(rect.width, rect.height, radius)
    if (!id) return
    // 亮色模式下背景是浅色彩场，饱和度再拉高会发艳，用更克制的参数
    const isDark = document.documentElement.classList.contains('dark')
    const value = isDark
      ? `url(#${id}) blur(0.4px) saturate(1.35)`
      : `url(#${id}) blur(0.5px) saturate(1.12)`
    if (el.dataset.lgFilter === id && el.dataset.lgMode === (isDark ? 'd' : 'l')) return
    el.dataset.lgFilter = id
    el.dataset.lgMode = isDark ? 'd' : 'l'
    el.style.setProperty('backdrop-filter', value)
    el.style.setProperty('-webkit-backdrop-filter', value)
    applied += 1
  })
  return applied
}

/**
 * 清除已应用的折射（切回亮色模式时必须调用）。
 * 折射是直接写在元素 style 上的内联 backdrop-filter，
 * 不清掉会残留在亮色模式里，把亮色模式的卡片也糊掉。
 */
export function resetRefraction(root: ParentNode = document.body): void {
  root.querySelectorAll<HTMLElement>(LIQUID_SELECTOR).forEach((el) => {
    el.style.removeProperty('backdrop-filter')
    el.style.removeProperty('-webkit-backdrop-filter')
    delete el.dataset.lgFilter
  })
}
