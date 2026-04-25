export interface EmbeddingsHealthResult {
  ok: boolean;
  attempts: number;
  status?: number;
  message?: string;
  endpoint?: string;
}

export interface EmbeddingsProvider {
  readonly name: string;
  readonly enabled: boolean;
  checkHealth(): Promise<EmbeddingsHealthResult>;
  embed(texts: string[]): Promise<number[][]>;
}

export class DisabledEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "disabled";
  readonly enabled = false;

  async checkHealth(): Promise<EmbeddingsHealthResult> {
    return {
      ok: false,
      attempts: 0,
      message: "Embeddings are disabled by configuration",
    };
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error("Embeddings are disabled");
  }
}
