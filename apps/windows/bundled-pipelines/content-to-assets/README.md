/**
 * 小红书图卡渲染器（`content-to-assets` 的插图与封面判据）。
 *
 * **为什么不用 `image_generate`**（2026-11-03 真机对照）：
 * - 它不收 `width`/`height`（传了会 400），只能出服务商默认比例；
 * - 小红书要 3:4，旧技能用 HTML 卡片 + 浏览器截图做到了精确 1080×1440；
 * - AI 生图还会把中文画成乱码（"画面干净，不要文字"这条约束就是为了绕开它）。
 *
 * HTML 卡片的三个好处：尺寸由模板写死、文案是我们自己的字、不依赖外部服务。
 *
 * 用法（流水线里由 agent 调 browser_navigate + browser_screenshot 完成截图，
 * 这个脚本只负责「生成 HTML」与「验收像素尺寸」两件事）：
 *
 *   生成：node render-cards.mjs <note.md> <输出目录> [每屏条数，缺省 3]
 *   验收：node check-assets.cjs <images 目录>   ← 同一目录下，见 check-assets.cjs
 */
