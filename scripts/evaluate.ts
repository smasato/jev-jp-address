/**
 * eval/samples.json を CLI パイプラインに通し、期待値と突合して Markdown レポートを出力する。
 *   npx tsx scripts/evaluate.ts            # Jev あり (TYPESAFE_AI_API_KEY 必須)
 *   npx tsx scripts/evaluate.ts --no-ai    # ルールのみ
 *   出力: eval/report(-no-ai).md, eval/results(-no-ai).json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Jev } from '../src/jev.js';
import { loadMaster } from '../src/master.js';
import { normalizeAddress, type NormalizeResult } from '../src/pipeline.js';

interface Sample {
  id: string;
  input: string;
  category: string;
  source: string;
  expect: {
    prefecture?: string | null;
    city?: string | null;
    town?: string | null;
    zip?: string | null;
    zipAlt?: string[];
    block?: string;
    needsReview?: boolean;
  };
}

const ROOT = resolve(import.meta.dirname, '..');
const noAi = process.argv.includes('--no-ai');
const suffix = noAi ? '-no-ai' : '';

const samples: Sample[] = JSON.parse(readFileSync(resolve(ROOT, 'eval/samples.json'), 'utf8'));
const master = loadMaster(resolve(ROOT, 'data/utf_ken_all.csv'), resolve(ROOT, 'data/jigyosyo_utf8.csv'));
const jev = noAi ? null : new Jev({ apiKey: process.env.TYPESAFE_AI_API_KEY });

type Mark = 'ok' | 'partial' | 'ng';
interface Row {
  sample: Sample;
  result: NormalizeResult;
  townMark: Mark;
  zipMark: Mark;
  notes: string[];
}

function evalZip(s: Sample, r: NormalizeResult): { mark: Mark; note: string } {
  const { zip, zipAlt } = s.expect;
  if (zip === undefined) return { mark: 'ok', note: '' };
  if (r.postalCode === zip) return { mark: 'ok', note: '' };
  if (zipAlt?.includes(r.postalCode ?? '')) return { mark: 'partial', note: `別解 (${r.postalCode})` };
  if (r.townPostalCode === zip) return { mark: 'partial', note: `町域番号は一致 (最終 ${r.postalCode})` };
  return { mark: 'ng', note: `期待 ${zip} / 実際 ${r.postalCode ?? 'なし'}` };
}

function evalTown(s: Sample, r: NormalizeResult): { mark: Mark; note: string } {
  const e = s.expect;
  const notes: string[] = [];
  let mark: Mark = 'ok';
  if (e.prefecture !== undefined && r.prefecture !== e.prefecture) {
    mark = 'ng';
    notes.push(`都道府県 期待 ${e.prefecture} / 実際 ${r.prefecture}`);
  }
  if (e.city !== undefined && r.city !== e.city) {
    mark = 'ng';
    notes.push(`市区町村 期待 ${e.city} / 実際 ${r.city}`);
  }
  if (e.town !== undefined && r.town !== e.town) {
    mark = 'ng';
    notes.push(`町域 期待 ${JSON.stringify(e.town)} / 実際 ${JSON.stringify(r.town)}`);
  }
  if (e.block !== undefined && r.block !== e.block) {
    if (mark === 'ok') mark = 'partial';
    notes.push(`番地 期待 ${e.block} / 実際 ${r.block}`);
  }
  if (e.needsReview !== undefined && r.needsReview !== e.needsReview) {
    if (mark === 'ok') mark = 'partial';
    notes.push(`要レビュー 期待 ${e.needsReview} / 実際 ${r.needsReview}`);
  }
  return { mark, note: notes.join('; ') };
}

const SYM: Record<Mark, string> = { ok: '○', partial: '△', ng: '×' };
const fz = (z: string | null) => (z ? `${z.slice(0, 3)}-${z.slice(3)}` : '-');

async function main() {
  const rows: Row[] = [];
  const t0 = performance.now();
  for (const s of samples) {
    const result = await normalizeAddress(s.input, { master, jev });
    const t = evalTown(s, result);
    const z = evalZip(s, result);
    rows.push({ sample: s, result, townMark: t.mark, zipMark: z.mark, notes: [t.note, z.note].filter(Boolean) });
    console.error(`${SYM[t.mark]}${SYM[z.mark]} ${s.id} ${s.input} → ${result.normalized} ${fz(result.postalCode)}`);
  }
  const elapsed = Math.round(performance.now() - t0);

  const count = (k: 'townMark' | 'zipMark', m: Mark) => rows.filter((r) => r[k] === m).length;
  const aiCalls = rows.reduce((a, r) => a + r.result.ai.calls, 0);
  const aiTokens = rows.reduce((a, r) => a + r.result.ai.inputTokens, 0);
  const aiMs = rows.reduce((a, r) => a + r.result.ai.latencyMs, 0);
  const aiUsed = rows.filter((r) => r.result.ai.calls > 0).length;

  const md: string[] = [];
  md.push(`# 評価レポート (${noAi ? 'ルールのみ / --no-ai' : 'Jev あり'})`);
  md.push('');
  md.push(`- 実行日時: ${new Date().toISOString()}`);
  md.push(`- サンプル数: ${rows.length}、所要 ${elapsed}ms`);
  md.push(`- 町域まで一致 (都道府県/市区町村/町域): ○ ${count('townMark', 'ok')} / △ ${count('townMark', 'partial')} / × ${count('townMark', 'ng')}`);
  md.push(`- 郵便番号一致: ○ ${count('zipMark', 'ok')} / △ ${count('zipMark', 'partial')} / × ${count('zipMark', 'ng')}`);
  md.push(`- Jev 呼び出し: ${aiCalls} 回 (${aiUsed} 件で使用)、入力 ${aiTokens} tokens、合計 ${aiMs}ms`);
  md.push(`- 要レビュー件数: ${rows.filter((r) => r.result.needsReview).length}`);
  md.push('');
  md.push('○=一致 △=部分一致(別解/町域番号のみ一致/番地・レビュー判定の差) ×=不一致');
  md.push('');
  md.push('| ID | 入力 | 分類 | 正規化結果 | 郵便番号 | 期待 | 町域 | 〒 | 判定手段 (県/市/町) | 備考 |');
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const st = r.result.stages;
    const m = (s: typeof st.prefecture) => (s.method === 'ai' ? `ai(p=${s.probability.toFixed(2)})` : s.method);
    const kind = r.result.postalCodeKind && r.result.postalCodeKind !== 'town' ? ` (${r.result.postalCodeKind})` : '';
    const notes = [...r.notes, ...(r.result.needsReview ? [`要レビュー: ${r.result.reasons.join(' / ')}`] : [])].join('<br>');
    md.push(
      `| ${r.sample.id} | ${r.sample.input} | ${r.sample.category} | ${r.result.normalized} | ${fz(r.result.postalCode)}${kind} | ${fz(r.sample.expect.zip ?? null)} | ${SYM[r.townMark]} | ${SYM[r.zipMark]} | ${m(st.prefecture)}/${m(st.city)}/${m(st.town)} | ${notes} |`,
    );
  }
  md.push('');
  md.push('## 出典');
  for (const src of new Set(samples.map((s) => s.source))) md.push(`- ${src}`);
  md.push('');

  writeFileSync(resolve(ROOT, `eval/report${suffix}.md`), md.join('\n'));
  writeFileSync(resolve(ROOT, `eval/results${suffix}.json`), JSON.stringify(rows.map((r) => ({ id: r.sample.id, townMark: r.townMark, zipMark: r.zipMark, result: r.result })), null, 2));
  console.error(`\n町域 ○${count('townMark', 'ok')} △${count('townMark', 'partial')} ×${count('townMark', 'ng')} | 〒 ○${count('zipMark', 'ok')} △${count('zipMark', 'partial')} ×${count('zipMark', 'ng')} | Jev ${aiCalls} calls`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
