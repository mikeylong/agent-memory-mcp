import type { EmbeddingsHealthResult, EmbeddingsProvider } from "./provider.js";

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

function describeHealthError(error: unknown): string {
  if (error instanceof Error) {
    return error.name ? `${error.name}: ${error.message}` : error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class OllamaEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "ollama";
  readonly enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 5000,
    private readonly healthOptions: {
      attempts?: number;
      timeoutMs?: number;
      backoffMs?: number;
    } = {},
  ) {}

  private async fetchWithTimeout(
    input: string,
    init?: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth(): Promise<EmbeddingsHealthResult> {
    const endpoint = `${this.baseUrl}/api/tags`;
    const maxAttempts = Math.max(1, Math.trunc(this.healthOptions.attempts ?? 3));
    const timeoutMs = Math.max(1, Math.trunc(this.healthOptions.timeoutMs ?? this.timeoutMs));
    const backoffMs = Math.max(0, Math.trunc(this.healthOptions.backoffMs ?? 100));
    let lastStatus: number | undefined;
    let lastMessage: string | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(endpoint, { method: "GET" }, timeoutMs);
        if (response.ok) {
          return {
            ok: true,
            attempts: attempt,
          };
        }

        lastStatus = response.status;
        lastMessage = `GET ${endpoint} returned HTTP ${response.status}`;
      } catch (error) {
        lastMessage = describeHealthError(error);
      }

      if (attempt < maxAttempts && backoffMs > 0) {
        await sleep(backoffMs * attempt);
      }
    }

    return {
      ok: false,
      attempts: maxAttempts,
      status: lastStatus,
      message: lastMessage ?? `GET ${endpoint} failed`,
      endpoint,
    };
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const batched = await this.tryBatchEmbed(texts);
    if (batched.length === texts.length) {
      return batched;
    }

    return this.embedIndividually(texts);
  }

  private async tryBatchEmbed(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      if (!Array.isArray(payload.embeddings)) {
        return [];
      }

      return payload.embeddings;
    } catch {
      return [];
    }
  }

  private async embedIndividually(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];

    for (const text of texts) {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Embedding request failed with status ${response.status}`);
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      if (!Array.isArray(payload.embedding)) {
        throw new Error("Invalid embeddings response from Ollama");
      }

      results.push(payload.embedding);
    }

    return results;
  }
}
