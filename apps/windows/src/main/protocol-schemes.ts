import { protocol } from 'electron'

import { LOCAL_MEDIA_SCHEME } from './local-media-protocol'
import { REMOTE_MEDIA_SCHEME } from './remote-media-protocol'
import { PET_ASSET_SCHEME } from '../shared/pet-asset'
import { CLIENT_PLUGIN_SCHEME } from './client-plugin-protocol'

/**
 * 所有自定义 scheme 的 privileges **必须一次注册完**。
 *
 * 实测（2026-10-20）：`protocol.registerSchemesAsPrivileged` 是**替换**语义而不是累加——
 * 分三次调用时只有最后一次生效，前面注册的 scheme 会在渲染层报
 * `Fetch API cannot load ... URL scheme "lumii-plugin" is not supported`。
 *
 * 所以这里集中注册，各模块只导出自己的 scheme 名，不再各自调用。
 * 须在 `app.whenReady()` 之前调用。
 */
export function registerAllSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
    {
      // 远端媒体代理（ComfyUI /view 需要 Basic Auth，img/video 标签带不上头）
      scheme: REMOTE_MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
    {
      scheme: PET_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
    },
    {
      // 插件文件不需要 bypassCSP：CSP 里已显式放行 lumii-plugin:
      scheme: CLIENT_PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
}
