// browser-ctl · screenshot.mjs — full-page screenshot to a file; agent then inspects via read.
// Real implementation (puppeteer-core):
//   await page.screenshot({ path: out, fullPage: true });
//   console.log(JSON.stringify({ path: out }));
import { resolve } from "node:path";
const out = resolve(process.argv[2] ?? "page.png");
if (!/\.(png|jpe?g|webp)$/i.test(out)) { console.log("usage: node screenshot.mjs [out.png]"); process.exit(0); }
const probe = await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9222)}/json/version`, { signal: AbortSignal.timeout(700) }).then((r) => r.json()).catch(() => null);
if (!probe?.webSocketDebuggerUrl) {
  console.log("[shot] no CDP endpoint — run start.mjs first. A real run would execute:");
  console.log(`  page.screenshot({ path: ${JSON.stringify(out)}, fullPage: true }) -> { path }`);
  console.log("  (agent reads the file back with the read tool)");
  process.exit(0);
}
console.log(`[shot] live CDP at ${probe.webSocketDebuggerUrl}; skeleton stops here — real impl writes ${out}.`);
