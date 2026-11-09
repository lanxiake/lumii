/**
 * 命名音色锚点：把某次合成的开头一段存成参考音，之后用同一个名字合成就是同一个声音。
 *
 * 解决的是**跨次调用**的一致性：Breeze 没有固定音色 ID，同一句 instruction 每次
 * 调用采样出来的声音都不一样。系列内容（有声书多章、多集播客、分镜配音）必须用同一个锚点。
 */
import fs from 'node:fs'
import path from 'node:path'

export interface VoiceAnchor {
  audioPath: string
  text: string
}

interface AnchorMeta {
  text: string
  instruction?: string
  engine: string
  createdAt: string
}

/** 名字只允许字母数字、中文、下划线、短横线：直接当文件名用，不能带路径分隔符 */
const NAME_RE = /^[\p{L}\p{N}_-]{1,48}$/u

export function isValidVoiceName(name: string): boolean {
  return NAME_RE.test(name)
}

export class VoiceAnchorStore {
  constructor(private readonly dir: string) {}

  private paths(name: string): { wav: string; meta: string } {
    if (!isValidVoiceName(name)) {
      throw new Error(`音色名「${name}」不合法：只能用中英文、数字、下划线、短横线，最长 48 字`)
    }
    return { wav: path.join(this.dir, `${name}.wav`), meta: path.join(this.dir, `${name}.json`) }
  }

  get(name: string, engine: string): (VoiceAnchor & { instruction?: string }) | null {
    const p = this.paths(name)
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8')) as AnchorMeta
      // 锚点是某个引擎的参考音：换了引擎就不适用（另一个引擎没有克隆通道）
      if (meta.engine !== engine || !fs.existsSync(p.wav)) return null
      return { audioPath: p.wav, text: meta.text, instruction: meta.instruction }
    } catch {
      return null
    }
  }

  /** 把引擎生成的锚点复制进库（源文件归引擎管，可能随 provider 销毁被删） */
  save(name: string, engine: string, anchor: VoiceAnchor, instruction?: string): VoiceAnchor {
    const p = this.paths(name)
    fs.mkdirSync(this.dir, { recursive: true })
    // 先写临时文件再改名：写到一半崩溃不会留下坏锚点
    fs.copyFileSync(anchor.audioPath, `${p.wav}.tmp`)
    fs.renameSync(`${p.wav}.tmp`, p.wav)
    const meta: AnchorMeta = { text: anchor.text, instruction, engine, createdAt: new Date().toISOString() }
    fs.writeFileSync(`${p.meta}.tmp`, JSON.stringify(meta, null, 2))
    fs.renameSync(`${p.meta}.tmp`, p.meta)
    return { audioPath: p.wav, text: anchor.text }
  }

  remove(name: string): void {
    const p = this.paths(name)
    fs.rmSync(p.wav, { force: true })
    fs.rmSync(p.meta, { force: true })
  }

  list(engine?: string): Array<{ name: string; instruction?: string; engine: string; createdAt: string }> {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    return files
      .map((f) => {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as AnchorMeta
          return { name: f.slice(0, -5), instruction: meta.instruction, engine: meta.engine, createdAt: meta.createdAt }
        } catch {
          return null
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null && (!engine || x.engine === engine))
  }
}
