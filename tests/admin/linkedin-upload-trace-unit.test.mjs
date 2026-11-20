// LinkedIn's image uploadUrl carries signed query parameters, and the Netlify runtime's
// fetch tracing records every outgoing URL in full (docs/backend/OBSERVABILITY.md). This
// runs the runtime's own fetch instrumentation (@netlify/otel's, as the runtime installs
// it) against a real tracer, and checks the upload PUT leaves no span, while another
// call through the same client still does (so the harness really records). No network
// beyond localhost, no DB. Its own file: it installs a global OTel context manager.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { FetchInstrumentation } from "@netlify/otel/instrumentation-fetch";
import { createLinkedInClient } from "../../src/lib/linkedin/client.mjs";

const SIGNED = "ut=SIGNED-upload-token&m=AQ-signature";

describe("the image upload PUT is not traced (its URL is signed)", () => {
  let server, base, instrumentation;
  const exporter = new InMemorySpanExporter();

  before(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(req.url.startsWith("/v2/userinfo") ? 200 : 201, { "content-type": "application/json" });
        res.end(JSON.stringify({ sub: "abc123", name: "Member" }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    // As the Netlify runtime configures it (serverless-functions-api).
    instrumentation = new FetchInstrumentation({ skipHeaders: [/authorization|x-.*|via|alt-svc|server/] });
    instrumentation.setTracerProvider(provider);
    instrumentation.enable();
  });
  after(async () => {
    instrumentation?.disable();
    context.disable();
    await new Promise((r) => server.close(r));
  });

  // The client only talks to *.linkedin.com over https; send its requests to the local server.
  const toLocal = (url, init) => globalThis.fetch(String(url).replace(/^https:\/\/[^/]+/, base), init);
  const client = () => createLinkedInClient({ clientId: "id", clientSecret: "secret" }, { fetch: toLocal });
  const recorded = () => exporter.getFinishedSpans().map((s) => String(s.attributes["url.full"] ?? ""));

  it("records other calls, with their full URL (the control)", async () => {
    exporter.reset();
    await client().getProfile("tok");
    assert.ok(recorded().some((u) => u.endsWith("/v2/userinfo")), JSON.stringify(recorded()));
  });

  it("records no span for the upload, so the signed query never reaches a trace", async () => {
    exporter.reset();
    await client().uploadImage("tok", `https://www.linkedin.com/dms-uploads/sp/v2/D55/uploaded-image/0?${SIGNED}`,
      new Uint8Array([1, 2, 3]), "image/png");
    assert.deepEqual(recorded().filter((u) => u.includes("dms-uploads")), []);
    for (const s of exporter.getFinishedSpans()) assert.ok(!JSON.stringify(s.attributes).includes("SIGNED"));
    // And tracing is back on after it.
    await client().getProfile("tok");
    assert.ok(recorded().some((u) => u.endsWith("/v2/userinfo")));
  });
});
