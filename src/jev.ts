import { createTypeSafeAi } from '@ai-sdk/typesafe-ai';
import type { JSONValue } from 'ai';
import { experimental_evaluate as evaluate, type Experimental_EvaluationModel } from 'ai';

export const NONE = '__none__';

/** Jev の Choice は 1〜255 択。「該当なし」を加えるので候補は 254 件までに分割する。 */
const MAX_OPTIONS = 254;

export interface ChoiceResult {
  choice: string | null;
  probability: number;
  confidence: number | null;
  /** 上位候補（確率降順） */
  top: Array<{ option: string; probability: number }>;
}

export interface JevStats {
  calls: number;
  inputTokens: number;
  latencyMs: number;
}

export class Jev {
  private model: Experimental_EvaluationModel;
  readonly stats: JevStats = { calls: 0, inputTokens: 0, latencyMs: 0 };

  constructor(opts: { apiKey?: string; modelId?: string } = {}) {
    const provider = createTypeSafeAi({ apiKey: opts.apiKey });
    this.model = provider.evaluationModel(opts.modelId ?? 'jev-latest');
  }

  /**
   * 候補集合から 1 つ選ぶ。候補が 254 件を超える場合はチャンクごとに選び、勝者同士で決勝を行う。
   * 常に「該当なし」オプションを含める。
   */
  async choose(params: {
    state: Record<string, JSONValue>;
    instructions: string;
    options: string[];
    describe?: (option: string) => string | null;
    noneDescription: string;
    /** false のときは「該当なし」を含めず、必ず候補から選ばせる */
    allowNone?: boolean;
  }): Promise<ChoiceResult> {
    const { options } = params;
    if (options.length === 0) return { choice: null, probability: 1, confidence: null, top: [] };
    if (options.length <= MAX_OPTIONS) return this.chooseOnce(params);

    const chunks: string[][] = [];
    for (let i = 0; i < options.length; i += MAX_OPTIONS) chunks.push(options.slice(i, i + MAX_OPTIONS));
    const winners = await Promise.all(chunks.map((c) => this.chooseOnce({ ...params, options: c })));
    const finalists = winners
      .flatMap((w) => w.top.filter((t) => t.option !== NONE).slice(0, 3).map((t) => t.option))
      .filter((v, i, a) => a.indexOf(v) === i);
    if (finalists.length === 0) {
      return { choice: null, probability: Math.max(...winners.map((w) => w.probability)), confidence: null, top: [] };
    }
    return this.chooseOnce({ ...params, options: finalists });
  }

  private async chooseOnce(params: {
    state: Record<string, JSONValue>;
    instructions: string;
    options: string[];
    describe?: (option: string) => string | null;
    noneDescription: string;
    allowNone?: boolean;
  }): Promise<ChoiceResult> {
    const criteria: Record<string, string | null> = {};
    for (const o of params.options) criteria[o] = params.describe?.(o) ?? null;
    if (params.allowNone !== false) criteria[NONE] = params.noneDescription;

    const t0 = performance.now();
    const result = await evaluate({
      model: this.model,
      state: params.state,
      questions: {
        pick: { type: 'choice', instructions: params.instructions, criteria },
      },
    });
    this.stats.calls++;
    this.stats.latencyMs += performance.now() - t0;
    this.stats.inputTokens += result.usage.inputTokens ?? 0;

    const ans = result.answers.pick;
    const probs = ans.probabilities ?? {};
    const top = Object.entries(probs)
      .map(([option, probability]) => ({ option, probability }))
      .sort((a, b) => b.probability - a.probability);
    const confidenceMeta = result.providerMetadata?.typesafe?.confidence;
    const confidence =
      confidenceMeta && typeof confidenceMeta === 'object' && 'pick' in confidenceMeta
        ? Number((confidenceMeta as Record<string, unknown>).pick)
        : null;
    const choice = ans.choice === NONE ? null : ans.choice;
    return { choice, probability: probs[ans.choice] ?? 1, confidence, top };
  }

  /** Boolean 質問（P(true) を返す） */
  async ask(state: Record<string, JSONValue>, instructions: string): Promise<number> {
    const t0 = performance.now();
    const result = await evaluate({
      model: this.model,
      state,
      questions: { q: { type: 'boolean', instructions } },
    });
    this.stats.calls++;
    this.stats.latencyMs += performance.now() - t0;
    this.stats.inputTokens += result.usage.inputTokens ?? 0;
    return result.answers.q.probability;
  }
}
