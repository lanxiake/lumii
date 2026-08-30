import { describe, expect, it } from 'vitest'

type GitHubAsset = { name: string; browser_download_url: string; size: number }
type GitHubRelease = { tag_name: string; assets: GitHubAsset[] }

/** 与 cloak-browser-downloader 中 findAssetForPlatform 逻辑一致（Windows 测试环境） */
function findAssetForPlatform(assets: GitHubAsset[]): GitHubAsset | null {
  const os = 'windows'
  const arch = 'x64'
  const ext = '.zip'
  return (
    assets.find((a) => a.name.includes(os) && a.name.includes(arch) && a.name.endsWith(ext)) ?? null
  )
}

/** 与 cloak-browser-downloader 中 pickInstallableRelease 逻辑一致 */
function pickInstallableRelease(releases: GitHubRelease[]): GitHubRelease | null {
  for (const release of releases) {
    if (findAssetForPlatform(release.assets ?? [])) return release
  }
  return null
}

describe('cloak-browser-downloader release 选择', () => {
  it('Pro 版 release（仅 SHA256SUMS）应被跳过', () => {
    const releases: GitHubRelease[] = [
      {
        tag_name: 'chromium-v151.0.7922.108.3-pro',
        assets: [
          { name: 'SHA256SUMS', browser_download_url: 'https://example.com/sums', size: 100 },
        ],
      },
      {
        tag_name: 'chromium-v146.0.7680.177.5',
        assets: [
          {
            name: 'cloakbrowser-windows-x64.zip',
            browser_download_url: 'https://example.com/win.zip',
            size: 500_000_000,
          },
        ],
      },
    ]
    const picked = pickInstallableRelease(releases)
    expect(picked?.tag_name).toBe('chromium-v146.0.7680.177.5')
  })

  it('latest 含 windows-x64 时直接选用', () => {
    const releases: GitHubRelease[] = [
      {
        tag_name: 'chromium-v146.0.7680.177.5',
        assets: [
          {
            name: 'cloakbrowser-windows-x64.zip',
            browser_download_url: 'https://example.com/win.zip',
            size: 500_000_000,
          },
        ],
      },
    ]
    expect(findAssetForPlatform(releases[0].assets)).not.toBeNull()
    expect(pickInstallableRelease(releases)?.tag_name).toBe('chromium-v146.0.7680.177.5')
  })
})
