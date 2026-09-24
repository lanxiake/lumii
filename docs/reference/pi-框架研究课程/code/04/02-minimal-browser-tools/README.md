# browser-ctl — drive Chrome from a shell

Four tiny CLI tools, MCP-free. The fixed context cost is this README
(~225 tokens), read only when a task needs a browser — not tool schemas
injected on every request. Call tools through the bash tool.

## Tools

- `node start.mjs` — ensure Chrome runs with `--remote-debugging-port=9222`; prints the `ws://` endpoint.
- `node nav.mjs <url>` — navigate the current page; prints `{title,url}`.
- `node eval.mjs "<expr>"` — run JS in the page, print JSON result. Use for data and state.
- `node screenshot.mjs [out.png]` — full-page screenshot; inspect it with the read tool.

## Notes

- Zero-dependency skeletons: without a live CDP endpoint each tool prints the
  command a real run would issue (puppeteer-core + `chrome --remote-debugging-port`) and exits 0.
- State lives in the Chrome profile (`./chrome-profile`): nav -> eval -> screenshot compose.
- Prefer eval over screenshots when you need data.
