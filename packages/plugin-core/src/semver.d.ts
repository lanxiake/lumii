/**
 * `semver` 不带类型、`@types/semver` 不在本机离线缓存中。
 * 这里只声明实际用到的那一个函数，够用且不用新增依赖。
 */
declare module "semver/functions/satisfies.js" {
  export default function satisfies(version: string, range: string): boolean;
}
