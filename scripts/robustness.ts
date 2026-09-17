/**
 * 文字欠落・誤字・入替・かな表記といった摂動を自動生成し、ルールのみ vs Jev あり の耐性を比較する。
 *   npx tsx scripts/robustness.ts [--seed 1] [--types del_town,typo_town,...]
 *   出力: eval/robustness.md, eval/robustness.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Jev } from '../src/jev.js';
import { cleanTown, loadMaster, placeKey } from '../src/master.js';
import { normalizeAddress, type NormalizeResult, type Stage } from '../src/pipeline.js';

const ROOT = resolve(import.meta.dirname, '..');
const KEN_ALL = resolve(ROOT, 'data/utf_ken_all.csv');
const { values: args } = parseArgs({
  options: { seed: { type: 'string', default: '1' }, types: { type: 'string' }, threshold: { type: 'string', default: '0.7' } },
});
const THRESHOLD = Number(args.threshold);

interface Sample {
  id: string;
  input: string;
  expect: { town?: string | null; zip?: string | null; needsReview?: boolean };
}
interface Base {
  id: string;
  prefecture: string;
  city: string;
  town: string;
  block: string;
  zip: string;
  canonical: string;
}
type PerturbType = 'del_town' | 'del_city' | 'typo_town' | 'typo_city' | 'swap_town' | 'kana_town' | 'kana_city' | 'kana_all';
const ALL_TYPES: PerturbType[] = ['del_town', 'del_city', 'typo_town', 'typo_city', 'swap_town', 'kana_town', 'kana_city', 'kana_all'];
const TYPE_LABEL: Record<PerturbType, string> = {
  del_town: '町域名の 1 文字欠落',
  del_city: '市区町村名の 1 文字欠落',
  typo_town: '町域名の 1 文字誤字（無関係な漢字に置換）',
  typo_city: '市区町村名の 1 文字誤字',
  swap_town: '町域名の隣接 2 文字入替',
  kana_town: '町域名をひらがな表記',
  kana_city: '市区町村名をひらがな表記',
  kana_all: '都道府県〜町域を全てひらがな表記',
};

interface Case {
  base: Base;
  type: PerturbType;
  input: string;
}
interface Outcome {
  townOk: boolean;
  zipOk: boolean;
  aiStages: Array<{ name: string; ok: boolean; p: number; conf: number | null }>;
  needsReview: boolean;
  result: NormalizeResult;
}
interface Row {
  case: Case;
  rule: Outcome;
  ai: Outcome | null;
}

// --- 乱数（再現性のため seed 固定） -----------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(args.seed));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

// --- 読み（カナ）をマスタから引く -----------------------------------------
const kataToHira = (s: string) => s.normalize('NFKC').replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const kana = { pref: new Map<string, string>(), city: new Map<string, string>(), town: new Map<string, string>() };
for (const line of readFileSync(KEN_ALL, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const f = line.split(',').map((x) => x.replace(/^"|"$/g, ''));
  const [prefK, cityK, townK, pref, city, townRaw] = [f[3], f[4], f[5], f[6], f[7], f[8]];
  kana.pref.set(pref, kataToHira(prefK));
  kana.city.set(`${pref}|${city}`, kataToHira(cityK));
  const t = cleanTown(townRaw);
  if (t) kana.town.set(placeKey(pref, city, t), kataToHira(townK.replace(/\(.*$/, '').replace(/（.*$/, '')));
}

// --- 摂動 -----------------------------------------------------------------
const CITY_SUFFIX = /[市区町村郡]$/;
function deleteChar(s: string, protectLast: boolean): string | null {
  const cs = Array.from(s);
  const n = protectLast && CITY_SUFFIX.test(s) ? cs.length - 1 : cs.length;
  if (n < 2) return null;
  cs.splice(Math.floor(rand() * n), 1);
  return cs.join('');
}
function swapChars(s: string): string | null {
  const cs = Array.from(s);
  const idx = cs.map((_, i) => i).filter((i) => i < cs.length - 1 && cs[i] !== cs[i + 1] && /[\u4e00-\u9fff]/.test(cs[i]) && /[\u4e00-\u9fff]/.test(cs[i + 1]));
  if (idx.length === 0) return null;
  const i = pick(idx);
  [cs[i], cs[i + 1]] = [cs[i + 1], cs[i]];
  return cs.join('');
}
function typoChar(s: string, pool: string[], protectLast: boolean): string | null {
  const cs = Array.from(s);
  const n = protectLast && CITY_SUFFIX.test(s) ? cs.length - 1 : cs.length;
  const idx = cs.map((_, i) => i).filter((i) => i < n && /[\u4e00-\u9fff]/.test(cs[i]));
  if (idx.length === 0) return null;
  const i = pick(idx);
  let c = pick(pool);
  while (c === cs[i]) c = pick(pool);
  cs[i] = c;
  return cs.join('');
}

function perturb(b: Base, type: PerturbType, kanjiPool: string[]): string | null {
  const tail = b.block;
  const mk = (pref: string, city: string, town: string) => `${pref}${city}${town}${tail}`;
  switch (type) {
    case 'del_town': {
      const t = deleteChar(b.town, false);
      return t === null || t === b.town ? null : mk(b.prefecture, b.city, t);
    }
    case 'del_city': {
      const c = deleteChar(b.city, true);
      return c === null ? null : mk(b.prefecture, c, b.town);
    }
    case 'typo_town': {
      const t = typoChar(b.town, kanjiPool, false);
      return t === null ? null : mk(b.prefecture, b.city, t);
    }
    case 'typo_city': {
      const c = typoChar(b.city, kanjiPool, true);
      return c === null ? null : mk(b.prefecture, c, b.town);
    }
    case 'swap_town': {
      const t = swapChars(b.town);
      return t === null ? null : mk(b.prefecture, b.city, t);
    }
    case 'kana_town': {
      const k = kana.town.get(placeKey(b.prefecture, b.city, b.town));
      return k ? mk(b.prefecture, b.city, k) : null;
    }
    case 'kana_city': {
      const k = kana.city.get(`${b.prefecture}|${b.city}`);
      return k ? mk(b.prefecture, k, b.town) : null;
    }
    case 'kana_all': {
      const p = kana.pref.get(b.prefecture);
      const c = kana.city.get(`${b.prefecture}|${b.city}`);
      const t = kana.town.get(placeKey(b.prefecture, b.city, b.town));
      return p && c && t ? mk(p, c, t) : null;
    }
  }
}

// --- 評価 -----------------------------------------------------------------
function outcome(b: Base, r: NormalizeResult): Outcome {
  const townOk = r.prefecture === b.prefecture && r.city === b.city && r.town === b.town;
  const zipOk = r.townPostalCode === b.zip || r.postalCode === b.zip;
  const aiStages: Outcome['aiStages'] = [];
  const check = (name: string, st: Stage, expected: string) => {
    if (st.method === 'ai') aiStages.push({ name, ok: st.value === expected, p: st.probability, conf: st.confidence ?? null });
  };
  check('都道府県', r.stages.prefecture, b.prefecture);
  check('市区町村', r.stages.city, b.city);
  check('町域', r.stages.town, b.town);
  return { townOk, zipOk, aiStages, needsReview: r.needsReview, result: r };
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(0)}% (${n}/${d})`);

async function main() {
  const master = loadMaster(KEN_ALL, resolve(ROOT, 'data/jigyosyo_utf8.csv'));
  const jev = new Jev({ apiKey: process.env.TYPESAFE_AI_API_KEY });
  const samples: Sample[] = JSON.parse(readFileSync(resolve(ROOT, 'eval/samples.json'), 'utf8'));
  const types = (args.types ? (args.types.split(',') as PerturbType[]) : ALL_TYPES).filter((t) => ALL_TYPES.includes(t));

  // 元サンプルをルールのみで正規化して正解が取れたものを「正規形」として基準にする
  const bases: Base[] = [];
  for (const s of samples) {
    if (!s.expect.town || !s.expect.zip || s.expect.needsReview) continue;
    const r = await normalizeAddress(s.input, { master, jev: null });
    if (!r.prefecture || !r.city || !r.town || r.town !== s.expect.town || !r.townPostalCode) continue;
    const canonical = `${r.prefecture}${r.city}${r.town}${r.block}`;
    if (bases.some((b) => b.canonical === canonical)) continue;
    bases.push({ id: s.id, prefecture: r.prefecture, city: r.city, town: r.town, block: r.block, zip: r.townPostalCode, canonical });
  }
  const kanjiPool = Array.from(new Set(Array.from(bases.map((b) => b.town + b.city).join('')).filter((c) => /[\u4e00-\u9fff]/.test(c))));

  const cases: Case[] = [];
  for (const b of bases) {
    for (const type of types) {
      const input = perturb(b, type, kanjiPool);
      if (input && input !== b.canonical) cases.push({ base: b, type, input });
    }
  }
  console.error(`bases=${bases.length} cases=${cases.length}`);

  const rows: Row[] = [];
  for (const c of cases) {
    const rule = outcome(c.base, await normalizeAddress(c.input, { master, jev: null, reviewThreshold: THRESHOLD }));
    let ai: Outcome | null = null;
    try {
      ai = outcome(c.base, await normalizeAddress(c.input, { master, jev, reviewThreshold: THRESHOLD }));
    } catch (e) {
      console.error(`  Jev error on ${c.input}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const mark = (o: Outcome | null) => (o === null ? '?' : o.townOk ? '○' : o.needsReview ? '△' : '×');
    console.error(`${mark(rule)}${mark(ai)} [${c.type}] ${c.input} → rule:${rule.result.normalized} | jev:${ai?.result.normalized ?? '-'}`);
    rows.push({ case: c, rule, ai });
  }

  // --- 集計 ---
  const md: string[] = [];
  md.push('# 摂動耐性レポート（ルールのみ vs Jev あり）');
  md.push('');
  md.push(`- 実行日時: ${new Date().toISOString()}、seed=${args.seed}、レビュー閾値 p<${THRESHOLD}`);
  md.push(`- 基準住所: ${bases.length} 件（eval/samples.json のうちルールのみで正解した住所の正規形）`);
  md.push(`- 摂動ケース: ${rows.length} 件（${types.length} 種）`);
  const aiCalls = rows.reduce((a, r) => a + (r.ai?.result.ai.calls ?? 0), 0);
  const aiTok = rows.reduce((a, r) => a + (r.ai?.result.ai.inputTokens ?? 0), 0);
  const aiMs = rows.reduce((a, r) => a + (r.ai?.result.ai.latencyMs ?? 0), 0);
  md.push(`- Jev 呼び出し: ${aiCalls} 回、入力 ${aiTok} tokens、合計 ${aiMs}ms（1 件あたり ${rows.length ? Math.round(aiMs / rows.length) : 0}ms）`);
  md.push('');
  md.push('## 摂動種別ごとの正答率（都道府県・市区町村・町域が全て一致）');
  md.push('');
  md.push('| 摂動 | n | ルールのみ | Jev あり | 郵便番号 (ルール) | 郵便番号 (Jev) | Jev が救済 | Jev で悪化 | 不正解のうち要レビュー (Jev) |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  const summarize = (label: string, rs: Row[]) => {
    const withAi = rs.filter((r) => r.ai !== null);
    const ruleOk = rs.filter((r) => r.rule.townOk).length;
    const aiOk = withAi.filter((r) => r.ai!.townOk).length;
    const ruleZip = rs.filter((r) => r.rule.zipOk).length;
    const aiZip = withAi.filter((r) => r.ai!.zipOk).length;
    const rescued = withAi.filter((r) => !r.rule.townOk && r.ai!.townOk).length;
    const broke = withAi.filter((r) => r.rule.townOk && !r.ai!.townOk).length;
    const aiWrong = withAi.filter((r) => !r.ai!.townOk);
    const aiWrongFlagged = aiWrong.filter((r) => r.ai!.needsReview).length;
    md.push(
      `| ${label} | ${rs.length} | ${pct(ruleOk, rs.length)} | ${pct(aiOk, withAi.length)} | ${pct(ruleZip, rs.length)} | ${pct(aiZip, withAi.length)} | ${rescued} | ${broke} | ${pct(aiWrongFlagged, aiWrong.length)} |`,
    );
  };
  for (const t of types) summarize(TYPE_LABEL[t], rows.filter((r) => r.case.type === t));
  summarize('**合計**', rows);
  md.push('');

  // 確度のキャリブレーション
  const stages = rows.flatMap((r) => r.ai?.aiStages ?? []);
  const okS = stages.filter((s) => s.ok);
  const ngS = stages.filter((s) => !s.ok);
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '-');
  md.push('## Jev の確度と正誤の関係（Jev が判定した段階のみ）');
  md.push('');
  md.push(`- Jev 判定回数: ${stages.length}（正解 ${okS.length} / 不正解 ${ngS.length}）`);
  md.push(`- 平均 probability: 正解 ${mean(okS.map((s) => s.p))} / 不正解 ${mean(ngS.map((s) => s.p))}`);
  md.push(`- 平均 confidence: 正解 ${mean(okS.map((s) => s.conf ?? s.p))} / 不正解 ${mean(ngS.map((s) => s.conf ?? s.p))}`);
  md.push(`- 閾値 ${THRESHOLD} 未満で要レビューになる割合: 正解 ${pct(okS.filter((s) => s.p < THRESHOLD).length, okS.length)} / 不正解 ${pct(ngS.filter((s) => s.p < THRESHOLD).length, ngS.length)}`);
  md.push('');
  md.push('| probability 帯 | 判定数 | 正解率 |');
  md.push('|---|---|---|');
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]] as Array<[number, number]>) {
    const bin = stages.filter((s) => s.p >= lo && s.p < hi);
    md.push(`| ${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)} | ${bin.length} | ${pct(bin.filter((s) => s.ok).length, bin.length)} |`);
  }
  md.push('');

  md.push('## 個別結果');
  md.push('');
  md.push('○=正解 △=不正解だが要レビュー ×=不正解で要レビューにならない');
  md.push('');
  md.push('| 摂動 | 入力 | 正解 | ルールのみ | Jev あり | Jev 判定 (p) | 備考 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const mark = (o: Outcome | null) => (o === null ? '?' : o.townOk ? '○' : o.needsReview ? '△' : '×');
    const show = (o: Outcome | null) => (o === null ? '(error)' : `${mark(o)} ${o.result.normalized}`);
    const aiInfo = r.ai?.aiStages.map((s) => `${s.name}=${s.ok ? '○' : '×'}(${s.p.toFixed(2)})`).join(' ') ?? '';
    const note = r.ai?.result.reasons.join(' / ') ?? '';
    md.push(`| ${r.case.type} | ${r.case.input} | ${r.case.base.canonical} | ${show(r.rule)} | ${show(r.ai)} | ${aiInfo} | ${note} |`);
  }
  md.push('');
  writeFileSync(resolve(ROOT, 'eval/robustness.md'), md.join('\n'));
  writeFileSync(
    resolve(ROOT, 'eval/robustness.json'),
    JSON.stringify(rows.map((r) => ({ type: r.case.type, input: r.case.input, base: r.case.base, rule: r.rule.result, ai: r.ai?.result ?? null })), null, 2),
  );
  console.error('\nwritten eval/robustness.md');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
