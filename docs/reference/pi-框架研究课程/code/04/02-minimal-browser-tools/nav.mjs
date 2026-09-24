// browser-ctl · nav.mjs — navigate the current page to a URL, print {title,url}.
// Real implementation (puppeteer-core):
//   const b = await puppeteer.connect({ browserWSEndpoint });
//   const p = (await b.pages())[0] ?? await b.newPage();
//   await p.goto(url, { waitUntil: "domcontentloaded" });
//   return { title: await p.title(), url: p.url() };
const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) { console.log("usage: node nav.mjs <http(s)-url>"); process.exit(0); }
const probe = await fetch(`http://127.0.0.1:${Number(process.env.CDP_PORT || 9222)}/json/version`, { signal: AbortSignal.timeout(700) }).then((r) => r.json()).catch(() => null);
if (!probe?.webSocketDebuggerUrl) {
  console.log("[nav] no CDP endpoint — run start.mjs first. A real run would execute:");
  console.log(`  puppeteer.connect({ browserWSEndpoint: <ws endpoint> })`);
  console.log(`  page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" }) -> { title, url }`);
  process.exit(0);
}
console.log(`[nav] live CDP at ${probe.webSocketDebuggerUrl}; skeleton stops here — real impl runs page.goto and prints JSON.`);
