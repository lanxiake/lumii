/**
 * 文本 sha256（renderer）
 *
 * 用于就地修改的 baseHash：渲染层按「加载到的磁盘内容」算一次，主进程应用前
 * 再按磁盘字节算一次；不一致说明文件已被外部改动。
 */

export async function sha256Text(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
