import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaEmbeddingsProvider } from "../../src/embeddings/ollama.js";

type RequestHandler = Parameters<typeof http.createServer>[0];

const cleanups: Array<() => Promise<void>> = [];

async function startServer(handler: RequestHandler): Promise<string> {
  const server = http.createServer(handler);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("OllamaEmbeddingsProvider health checks", () => {
  it("retries transient tag endpoint failures before reporting healthy", async () => {
    let calls = 0;
    const url = await startServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        calls += 1;
        if (calls === 1) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "warming up" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const provider = new OllamaEmbeddingsProvider(url, "nomic-embed-text", 5000, {
      attempts: 3,
      timeoutMs: 1000,
      backoffMs: 1,
    });

    await expect(provider.checkHealth()).resolves.toEqual({
      ok: true,
      attempts: 2,
    });
    expect(calls).toBe(2);
  });

  it("returns diagnostics after repeated tag endpoint failures", async () => {
    let calls = 0;
    const url = await startServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        calls += 1;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not ready" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const provider = new OllamaEmbeddingsProvider(url, "nomic-embed-text", 5000, {
      attempts: 3,
      timeoutMs: 1000,
      backoffMs: 1,
    });

    const health = await provider.checkHealth();

    expect(health).toMatchObject({
      ok: false,
      attempts: 3,
      status: 503,
      endpoint: `${url}/api/tags`,
    });
    expect(health.message).toContain("HTTP 503");
    expect(calls).toBe(3);
  });
});
