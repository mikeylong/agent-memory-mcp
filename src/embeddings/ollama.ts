import { EmbeddingsProvider } from "./provider.js";

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

export class OllamaEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "ollama";
  readonly enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs = 5000,
  ) {}

  private async fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/api/tags`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
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
