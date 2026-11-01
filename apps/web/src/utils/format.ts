/** 字节数格式化为可读字符串（GB / MB / KB） */
export function formatSize(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)}\u00a0GB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)}\u00a0MB`;
  return `${(bytes / 1024).toFixed(0)}\u00a0KB`;
}
