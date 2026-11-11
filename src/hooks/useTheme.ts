import { useSyncExternalStore } from 'react'

/**
 * 订阅 <html> 上的 .dark 类（主题切换的唯一事实来源，见 App.tsx）。
 * 图表组件用它取「当前主题对应的色板」——SVG 属性不吃 CSS 变量，
 * 只能把主题读进 JS 再选色。类变化由 App 的切换逻辑触发，MutationObserver 兜底。
 */
function subscribe(cb: () => void): () => void {
  const mo = new MutationObserver(cb)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => mo.disconnect()
}

const getSnapshot = (): boolean => document.documentElement.classList.contains('dark')

export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot)
}