/**
 * sanitize-pptx — 预览前清洗 PPTX，避免 pptx-preview 因残缺结构崩溃
 *
 * 常见问题：
 * - 部分生成器（含 pptxgenjs / 网页导出）在 [Content_Types].xml 里引用 ZIP 中不存在的部件
 * - slide 缺少 layout 关联时，库访问 slideLayout.background 会抛
 *   "Cannot read properties of undefined (reading 'background')"
 */

import JSZip from 'jszip'

const SLIDE_LAYOUT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'

/**
 * 从 Content_Types 中移除指向不存在文件的 Override
 */
function stripPhantomContentTypes(ctXml: string, zip: JSZip): string {
  return ctXml.replace(/<Override\b[^>]*\/>/g, (match) => {
    const m = /PartName="([^"]+)"/.exec(match)
    if (!m) return match
    const part = m[1].replace(/^\//, '')
    return zip.file(part) ? match : ''
  })
}

/**
 * 解析 slide 路径对应的 _rels 路径
 */
function slideRelsPath(slidePath: string): string {
  return slidePath.replace(/^(ppt\/slides\/)(slide\d+\.xml)$/i, '$1_rels/$2.rels')
}

/**
 * 确保每个 slide 的 .rels 至少有一条指向已存在 layout 的关系
 */
async function ensureSlideLayoutRels(zip: JSZip): Promise<boolean> {
  const layoutNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(n))
    .sort()
  if (layoutNames.length === 0) return false

  const layoutFileName = layoutNames[0].split('/').pop()!
  const target = `../slideLayouts/${layoutFileName}`
  let changed = false

  const slideFiles = Object.keys(zip.files).filter((n) =>
    /^ppt\/slides\/slide\d+\.xml$/i.test(n),
  )

  for (const slidePath of slideFiles) {
    const relsPath = slideRelsPath(slidePath)
    const relsFile = zip.file(relsPath)

    if (!relsFile) {
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${SLIDE_LAYOUT_REL}" Target="${target}"/>
</Relationships>`
      zip.file(relsPath, xml)
      changed = true
      continue
    }

    const relsXml = await relsFile.async('text')
    if (/slideLayout/i.test(relsXml)) continue

    const injection = `<Relationship Id="rIdLumiiLayout" Type="${SLIDE_LAYOUT_REL}" Target="${target}"/>`
    const next = relsXml.includes('</Relationships>')
      ? relsXml.replace('</Relationships>', `${injection}</Relationships>`)
      : `${relsXml}\n${injection}`
    zip.file(relsPath, next)
    changed = true
  }

  return changed
}

/**
 * 清洗 PPTX ArrayBuffer，返回更稳妥可预览的副本；失败则返回原缓冲
 */
export async function sanitizePptxForPreview(buf: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const zip = await JSZip.loadAsync(buf)
    let changed = false

    const ctFile = zip.file('[Content_Types].xml')
    if (ctFile) {
      const ct = await ctFile.async('text')
      const fixed = stripPhantomContentTypes(ct, zip)
      if (fixed !== ct) {
        zip.file('[Content_Types].xml', fixed)
        changed = true
      }
    }

    if (await ensureSlideLayoutRels(zip)) {
      changed = true
    }

    if (!changed) return buf
    return await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  } catch (e) {
    console.warn('[sanitizePptxForPreview] 清洗失败，使用原始字节:', e)
    return buf
  }
}
