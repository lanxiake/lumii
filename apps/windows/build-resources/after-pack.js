/**
 * electron-builder afterPack hook（开源独立版占位）。
 * 可按需扩展 native 模块校验、产物裁剪等逻辑。
 * @param {import('electron-builder').AfterPackContext} _context
 */
exports.default = async function afterPack(_context) {
  // no-op for Lumii offline packaging
}
