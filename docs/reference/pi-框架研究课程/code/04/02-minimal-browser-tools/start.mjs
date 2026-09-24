// browser-ctl · start.mjs — ensure Chrome exposes a CDP endpoint, print ws:// url.
// Zero-dependency skeleton: probes 127.0.0.1:9222/json/version (override: CDP_PORT=NNNN).
// When no browser is found it PRINTS what a real implementation would run and exits 0,
// so an agent can learn from the output instead of hitting an error wall.
// Real implementation: spawn Chrome with the flags below, or `npm i puppeteer-core`
// and puppeteer.connect({ browserWSEndpoint }) for all subsequent tools.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = join(process.cwd(), "chrome-profile");
const note = (m) => console.log("[start] " + m);

const probe = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(700) })
  .then((r) => r.json()).catch(() => null);
if (probe?.webSocketDebuggerUrl) {
  console.log(JSON.stringify({ ok: true, endpoint: probe.webSocketDebuggerUrl, browser: probe.Browser }));
  process.exit(0);
}

const chrome = process.env.CHROME_PATH
  ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
const argv = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "--headless=new", "about:blank"];

note(`no CDP endpoint at 127.0.0.1:${PORT}${chrome ? " — launching Chrome:" : " — no Chrome found (set CHROME_PATH)."}`);
if (chrome) { console.log("  " + [chrome, ...argv].join(" ")); spawn(chrome, argv, { detached: true, stdio: "ignore" }).unref(); note("re-run me in a second to get the ws:// endpoint."); }
else { note("a real implementation would run:"); console.log("  <chrome-binary> " + argv.join(" ")); note("then GET /json/version -> webSocketDebuggerUrl, and puppeteer.connect({ browserWSEndpoint })."); }
process.exit(0);
