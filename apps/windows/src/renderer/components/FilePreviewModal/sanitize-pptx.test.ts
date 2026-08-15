/**
 * sanitize-pptx 单元测试
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { sanitizePptxForPreview } from './sanitize-pptx'

/**
 * 构造缺 layout 关系的最小假 PPTX
 */
async function buildBrokenPptx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/missing/phantom.xml" ContentType="application/xml"/>
</Types>`,
  )
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
  zip.file(
    'ppt/slideLayouts/slideLayout1.xml',
    '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  )
  // 故意不写 slide1.xml.rels
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('sanitizePptxForPreview', () => {
  it('移除幽灵 Content_Types 并补上 slideLayout 关系', async () => {
    const raw = await buildBrokenPptx()
    const fixed = await sanitizePptxForPreview(raw)
    expect(fixed).toBeInstanceOf(ArrayBuffer)

    const zip = await JSZip.loadAsync(fixed)
    const ct = await zip.file('[Content_Types].xml')!.async('text')
    expect(ct).not.toContain('/ppt/missing/phantom.xml')
    expect(ct).toContain('/ppt/slides/slide1.xml')

    const rels = zip.file('ppt/slides/_rels/slide1.xml.rels')
    expect(rels).toBeTruthy()
    const relsXml = await rels!.async('text')
    expect(relsXml).toMatch(/slideLayout/i)
  })
})
