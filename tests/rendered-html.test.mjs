import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the finished One Night experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>[^<]*One Night[^<]*<\/title>/i);
  assert.match(html, /Trust no one/);
  assert.match(html, /before dawn/);
  assert.match(html, /Gather the village/);
  assert.match(html, /Wake in secret/);
  assert.match(html, /Fight for the floor/);
  assert.match(html, /property="og:image" content="http:\/\/localhost:3000\/og\.png"/);
  assert.match(html, /name="twitter:image" content="http:\/\/localhost:3000\/og\.png"/);
  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape/);
});

test("removes starter-preview code and metadata", async () => {
  const [page, layout, packageJson, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<GameApp \/>/);
  assert.match(layout, /One Night/);
  assert.match(packageJson, /"name": "one-night-llm"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
});

test("ships an accessible, viewer-safe night ceremony and persistent recap", async () => {
  const [gameApp, protocol, css] = await Promise.all([
    readFile(new URL("../app/game-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/shared/protocol.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(protocol, /interface NightHistoryEntryView/);
  assert.match(protocol, /status:\s*"upcoming"\s*\|\s*"active"\s*\|\s*"complete"/);
  assert.match(protocol, /privateKnowledge:\s*KnowledgeItem\[\]/);
  assert.match(gameApp, /Night history in role order/);
  assert.match(gameApp, /Night step \$\{activePosition\} of \$\{history\.length\}/);
  assert.match(gameApp, /Continue the night/);
  assert.match(gameApp, /Everyone, wake up/);
  assert.match(gameApp, /Your eyes were closed; whatever happened in this step stayed hidden/);
  assert.match(gameApp, /you are the lone original Werewolf/);
  assert.match(gameApp, /No player began as a Werewolf/);
  assert.match(gameApp, /What your open eyes revealed/);
  assert.match(css, /\.night-history-full/);
  assert.match(css, /\.night-ceremony/);
});

test("keeps the conversation in an independent scroll region", async () => {
  const [gameApp, css] = await Promise.all([
    readFile(new URL("../app/game-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(gameApp, /dialogue-panel conversation-panel panel/);
  assert.match(gameApp, /aria-label="Village conversation transcript"/);
  assert.match(gameApp, /tabIndex=\{0\}/);
  assert.match(css, /\.game-grid\s*\{[^}]*height:\s*calc\(100svh - 132px\)/s);
  assert.match(css, /\.transcript\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.transcript\s*\{[^}]*overscroll-behavior:\s*contain/s);
  assert.match(css, /\.conversation-panel\s*\{[^}]*height:\s*clamp\(/s);
});
