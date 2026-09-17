#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Jev } from './jev.js';
import { loadMaster } from './master.js';
import { normalizeAddress, type NormalizeResult } from './pipeline.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MASTER = resolve(HERE, '..', 'data', 'utf_ken_all.csv');
const DEFAULT_OFFICE = resolve(HERE, '..', 'data', 'jigyosyo_utf8.csv');

const USAGE = `使い方:
  jev-jp-address [options] <住所>
  cat addresses.txt | jev-jp-address [options]

options:
  --master <path>      KEN_ALL (UTF-8) CSV のパス      [default: data/utf_ken_all.csv]
  --office <path>      JIGYOSYO (UTF-8) CSV のパス     [default: data/jigyosyo_utf8.csv]
  --no-ai              Jev を使わずルール/マスタ照合のみで解決する
  --model <id>         TypeSafe のモデル ID            [default: jev-latest]
  --threshold <0-1>    この確度未満の AI 判定を要レビューにする [default: 0.7]
  --json               JSON (1行1件) で出力する
  --verbose            各段階の判定過程を stderr に出力する
  -h, --help

環境変数: TYPESAFE_AI_API_KEY (Jev を使う場合に必須)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      master: { type: 'string' },
      office: { type: 'string' },
      'no-ai': { type: 'boolean', default: false },
      model: { type: 'string' },
      threshold: { type: 'string' },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const masterPath = values.master ?? DEFAULT_MASTER;
  if (!existsSync(masterPath)) {
    console.error(`マスタが見つかりません: ${masterPath}\n日本郵便の utf_ken_all.zip を展開して配置してください。`);
    process.exit(2);
  }
  const officePath = values.office ?? (existsSync(DEFAULT_OFFICE) ? DEFAULT_OFFICE : undefined);

  const t0 = performance.now();
  const master = loadMaster(masterPath, officePath);
  if (values.verbose) console.error(`  [debug] master loaded: ${master.rows.length} rows in ${Math.round(performance.now() - t0)}ms`);

  let jev: Jev | null = null;
  if (!values['no-ai']) {
    if (!process.env.TYPESAFE_AI_API_KEY) {
      console.error('TYPESAFE_AI_API_KEY が設定されていません (--no-ai でルールのみ実行できます)');
      process.exit(2);
    }
    jev = new Jev({ apiKey: process.env.TYPESAFE_AI_API_KEY, modelId: values.model });
  }
  const threshold = values.threshold ? Number(values.threshold) : undefined;

  const inputs: string[] = positionals.length > 0 ? positionals : await readStdinLines();
  for (const input of inputs) {
    const result = await normalizeAddress(input, { master, jev, reviewThreshold: threshold, verbose: values.verbose });
    if (values.json) console.log(JSON.stringify(result, null, 0));
    else console.log(formatHuman(result));
  }
}

async function readStdinLines(): Promise<string[]> {
  const lines: string[] = [];
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const s = line.trim();
    if (s && !s.startsWith('#')) lines.push(s);
  }
  return lines;
}

function formatHuman(r: NormalizeResult): string {
  const st = (name: string, s: NormalizeResult['stages']['prefecture']) =>
    `  ${name}: ${s.value ?? '(不明)'}  [${s.method}${s.method === 'ai' ? ` p=${s.probability.toFixed(2)}${s.confidence != null ? ` conf=${s.confidence.toFixed(2)}` : ''}` : ''}]`;
  const zip = r.postalCode ? `${r.postalCode.slice(0, 3)}-${r.postalCode.slice(3)}` : '(不明)';
  const lines = [
    `入力: ${r.input}`,
    `正規化: ${r.normalized}`,
    `郵便番号: ${zip}${r.postalCodeKind && r.postalCodeKind !== 'town' ? ` (${r.postalCodeKind === 'building' ? '階層別' : '事業所個別'}; 町域 ${fmtZip(r.townPostalCode)})` : ''}`,
    st('都道府県', r.stages.prefecture),
    st('市区町村', r.stages.city),
    st('町域    ', r.stages.town),
    `  番地: ${r.block || '-'}  建物: ${r.building || '-'}`,
    `  AI: ${r.ai.calls} calls, ${r.ai.inputTokens} tokens, ${r.ai.latencyMs}ms`,
  ];
  if (r.needsReview) lines.push(`  ⚠ 要レビュー: ${r.reasons.join(' / ')}`);
  return lines.join('\n') + '\n';
}

function fmtZip(z: string | null): string {
  return z ? `${z.slice(0, 3)}-${z.slice(3)}` : '-';
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
