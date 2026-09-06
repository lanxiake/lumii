/**
 * 为 resources/app-ui-cli/commands.mjs 提供最小类型声明，
 * 供 command-allowlist.test.ts 做 CLI /command 与白名单对齐校验。
 */
export interface LumiiUiCommand {
  readonly name: string
  readonly route: { readonly path: string }
  readonly build: (args: unknown) => { readonly type?: string } | null
}
export const COMMANDS: readonly LumiiUiCommand[]
