// browser-ctl · eval.mjs — run a JS expression in the page, print its JSON result.
// The workhorse: DOM queries, attribute extraction, state checks all go through here.
// Real implementation (puppeteer-core):
//   const out = await page.evaluate(expr);   // CDP Runtime.evaluate, returnByValue
//   console.log(JSON.stringify(out ?? null));
const expr = process.argv[2];
if (!expr) { console.log('usage: node eval.mjs "<js expression>"   e.g. "document.title"'); process.exit(0); }
const probe = await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9222)}/json/version`, { signal: AbortSignal.timeout(700) }).then((r) => r.json()).catch(() => null);
if (!probe?.webSocketDebuggerUrl) {
  console.log("[eval] no CDP endpoint — run start.mjs first. A real run would execute:");
  console.log("  Runtime.evaluate(expression, { returnByValue: true }) -> print JSON");
  console.log(`  expression: ${expr}`);
  process.exit(0);
}
console.log(`[eval] live CDP at ${probe.webSocketDebuggerUrl}; skeleton stops here — real impl runs Runtime.evaluate and prints JSON.`);
