const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** 流量数值显示：0 是有效的“无流量”，与套餐额度语义区分。 */
export function formatTraffic(bytes: number): string {
  if (bytes <= 0) return "0 B";
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(2)} ${BYTE_UNITS[i]}`;
}

/** 字节数人性化显示；0 在业务语义里表示“不限”（套餐流量、额度），负数防御性显示 0。 */
export function formatBytes(bytes: number): string {
  return bytes <= 0 ? "不限" : formatTraffic(bytes);
}

/** ISO 时间 → `YYYY-MM-DD HH:mm`（本地展示用，秒级场景自行截取）。 */
export function formatDateTime(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}
