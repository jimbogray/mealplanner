import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { claudeRecipeReader } from "../src/recipe-reader.js";

// A stand-in for the Anthropic API, so the request shape and response parsing are checked offline.
test("claudeRecipeReader asks Claude Haiku for structured recipe details", async () => {
  let request: { headers: Record<string, unknown>; body: any } | undefined;
  const details = { isRecipe: true, name: "Beef stew", description: "A slow, rich stew.", cookingMinutes: 150, mainProtein: "Beef" };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    request = { headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: request.body.model,
        content: [{ type: "text", text: JSON.stringify(details) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const read = claudeRecipeReader("test-key", undefined, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.deepEqual(await read({ url: "https://example.com/stew", text: "Page text:\nBeef stew" }), details);
    assert.equal(request!.headers["x-api-key"], "test-key");
    assert.equal(request!.body.model, "claude-haiku-4-5");
    assert.equal(request!.body.output_config.format.type, "json_schema");
    assert.match(request!.body.messages[0].content, /URL: https:\/\/example.com\/stew\n\nPage text:\nBeef stew/);
  } finally {
    server.close();
  }
});
