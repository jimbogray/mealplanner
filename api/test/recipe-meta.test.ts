import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { fallbackTitle, fetchRecipeMeta, isPublicAddress, parseRecipeMeta } from "../src/recipe-meta.js";

const PAGE = "https://www.example.com/recipes/pancakes";

describe("parseRecipeMeta", () => {
  test("prefers the schema.org Recipe in JSON-LD, even inside @graph", () => {
    const html = `<html><head>
      <title>Pancakes | Example</title>
      <meta property="og:title" content="OG title">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
        {"@type":"WebPage","name":"Page"},
        {"@type":["Recipe","NewsArticle"],"name":"Fluffy &amp; easy pancakes","image":[{"@type":"ImageObject","url":"/img/p.jpg"}]}
      ]}</script>
      <meta property="og:site_name" content="Example Kitchen">
    </head></html>`;
    assert.deepEqual(parseRecipeMeta(html, PAGE), {
      title: "Fluffy & easy pancakes",
      imageUrl: "https://www.example.com/img/p.jpg",
      siteName: "Example Kitchen",
    });
  });

  test("falls back to Open Graph, then Twitter, then <title>", () => {
    const og = `<meta content='Chilli con carne' property='og:title'><meta name="twitter:image" content="https://cdn.example.com/c.jpg">`;
    assert.deepEqual(parseRecipeMeta(og, PAGE), { title: "Chilli con carne", imageUrl: "https://cdn.example.com/c.jpg", siteName: null });
    const bare = `<script type="application/ld+json">{ not json</script><title>\n  Soup &#8211; Mum's  </title>`;
    assert.deepEqual(parseRecipeMeta(bare, PAGE), { title: "Soup – Mum's", imageUrl: null, siteName: null });
  });

  test("ignores images that aren't web addresses", () => {
    assert.equal(parseRecipeMeta(`<meta property="og:image" content="javascript:alert(1)">`, PAGE).imageUrl, null);
  });
});

test("fallbackTitle is the link without the scheme or www", () => {
  assert.equal(fallbackTitle("https://www.example.com/recipes/stew/"), "example.com/recipes/stew");
});

describe("fetchRecipeMeta", () => {
  test("refuses private and loopback addresses", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      assert.equal(isPublicAddress(a), false, a);
    }
    assert.equal(isPublicAddress("93.184.216.34"), true);

    const server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>secret</title>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await assert.rejects(fetchRecipeMeta(`http://127.0.0.1:${port}/`), /isn't a public address/);
      await assert.rejects(fetchRecipeMeta(`http://localhost:${port}/`), /isn't a public address/);
      await assert.rejects(fetchRecipeMeta(`http://[::ffff:127.0.0.1]:${port}/`), /isn't a public address/);
    } finally {
      server.close();
    }
  });
});
