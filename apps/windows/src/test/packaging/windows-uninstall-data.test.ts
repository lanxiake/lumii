import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '../../../../..')

describe('Windows uninstall data policy', () => {
  it('keeps data by default and prompts before optional cleanup', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(root, 'apps/windows/electron-builder.json'), 'utf8'),
    ) as { nsis?: { deleteAppDataOnUninstall?: boolean } }
    const script = fs.readFileSync(path.join(root, 'apps/windows/build-resources/installer.nsh'), 'utf8')

    expect(config.nsis?.deleteAppDataOnUninstall).toBe(false)
    expect(script).toContain('customUnInit')
    expect(script).toContain('MB_DEFBUTTON2')
    expect(script).toContain('customUnInstall')
    expect(script).toContain('$APPDATA\\Lumii')
    expect(script).toContain('$LOCALAPPDATA\\Lumii')
    expect(script).toContain('$PROFILE\\.lumii')
  })
})
