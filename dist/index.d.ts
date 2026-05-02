import { Command } from 'just-bash';
import { PluginOptions } from 'just-bash-data';

interface WikiOptions extends PluginOptions {
    /** Embedding dimension for vector collections (default: 1536 for OpenAI) */
    embeddingDim?: number;
    /** Vector metric (default: cosine) */
    metric?: "cosine" | "euclidean" | "dot";
    /** Vector quantization (default: float32) */
    quantize?: "float32" | "int8";
}
declare function createWikiPlugin(opts?: WikiOptions): Command[];

export { type WikiOptions, createWikiPlugin };
