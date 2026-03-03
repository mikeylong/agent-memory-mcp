export interface EmbeddingsProvider {
  readonly name: string;
  readonly enabled: boolean;
  checkHealth(): Promise<boolean>;
  embed(texts: string[]): Promise<number[][]>;
}

export class DisabledEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "disabled";
  readonly enabled = false;

  async checkHealth(): Promise<boolean> {
    return false;
  }

  async embed(_texts: string[]): Promise<number[][]> {
    throw new Error("Embeddings are disabled");
  }
}
