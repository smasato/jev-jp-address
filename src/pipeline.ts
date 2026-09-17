import { Jev, type ChoiceResult } from './jev.js';
import { type Master, type ZipRow, findZips, placeKey } from './master.js';
import { bigramSimilarity, charOverlap, extractZip, hasKana, kanjiToNumber, key, preprocess, toKatakana } from './text.js';

export type Method = 'zip' | 'rule' | 'ai' | 'none';

export interface Stage {
  value: string | null;
  method: Method;
  probability: number;
  confidence?: number | null;
  alternatives?: Array<{ option: string; probability: number }>;
}

export interface NormalizeResult {
  input: string;
  normalized: string;
  postalCode: string | null;
  /** town=町域番号 / building=高層ビル階層別 / office=大口事業所個別 */
  postalCodeKind: 'town' | 'building' | 'office' | null;
  /** 町域の郵便番号（postalCode が階層別/事業所番号のときも町域番号を保持） */
  townPostalCode: string | null;
  prefecture: string | null;
  city: string | null;
  town: string | null;
  block: string;
  building: string;
  stages: { prefecture: Stage; city: Stage; town: Stage };
  needsReview: boolean;
  reasons: string[];
  ai: { calls: number; inputTokens: number; latencyMs: number };
}

export interface NormalizeOptions {
  master: Master;
  jev: Jev | null;
  reviewThreshold?: number;
  verbose?: boolean;
}

const PREF_SUFFIX = /(都|道|府|県)$/;

export async function normalizeAddress(raw: string, opts: NormalizeOptions): Promise<NormalizeResult> {
  const { master } = opts;
  const threshold = opts.reviewThreshold ?? 0.7;
  const reasons: string[] = [];
  const log = (m: string) => opts.verbose && console.error(`  [debug] ${m}`);
  const statsBefore = opts.jev ? { ...opts.jev.stats } : { calls: 0, inputTokens: 0, latencyMs: 0 };

  const pre = preprocess(raw);
  const { zip: inputZip, rest: afterZip } = extractZip(pre);
  const zipRows = inputZip ? master.byZip.get(inputZip) : undefined;
  if (inputZip && !zipRows) reasons.push(`郵便番号 ${inputZip} はマスタに存在しません`);
  let rest = afterZip.replace(/^[\s,、。・]+/, '');
  log(`preprocessed="${pre}" zip=${inputZip ?? '-'} rest="${rest}"`);

  // ---------- 都道府県 ----------
  const prefStage = await resolvePrefecture(rest, zipRows, opts, log);
  if (prefStage.stage.value === null) {
    return finish(raw, pre, inputZip, prefStage.stage, none(), none(), '', rest, reasons, opts, statsBefore, threshold);
  }
  rest = prefStage.rest;
  const pref = master.prefectures.find((p) => p.name === prefStage.stage.value)!;

  // ---------- 市区町村 ----------
  const cityStage = await resolveCity(rest, pref, zipRows, opts, log);
  if (cityStage.stage.value === null) {
    return finish(raw, pre, inputZip, prefStage.stage, cityStage.stage, none(), '', rest, reasons, opts, statsBefore, threshold);
  }
  rest = cityStage.rest;
  const city = pref.cities.find((c) => c.name === cityStage.stage.value)!;

  // ---------- 町域 ----------
  const townStage = await resolveTown(rest, pre, pref.name, city, zipRows, opts, log);
  rest = townStage.rest;

  // ---------- 番地・建物 ----------
  const { block, building } = parseBlockAndBuilding(rest);
  return finish(raw, pre, inputZip, prefStage.stage, cityStage.stage, townStage.stage, block, building, reasons, opts, statsBefore, threshold);
}

function none(): Stage {
  return { value: null, method: 'none', probability: 0 };
}

function finish(
  raw: string,
  pre: string,
  inputZip: string | null,
  prefecture: Stage,
  city: Stage,
  town: Stage,
  block: string,
  building: string,
  reasons: string[],
  opts: NormalizeOptions,
  statsBefore: { calls: number; inputTokens: number; latencyMs: number },
  threshold: number,
): NormalizeResult {
  const { master } = opts;
  let postalCode: string | null = null;
  if (prefecture.value && city.value && town.value !== null) {
    const zips = findZips(master, prefecture.value, city.value, town.value);
    if (zips.length === 1) postalCode = zips[0];
    else if (zips.length > 1) {
      const refined = refineZipByChome(master, prefecture.value, city.value, town.value, block, building);
      if (refined) postalCode = refined;
      else if (inputZip && zips.includes(inputZip)) postalCode = inputZip;
      else {
        postalCode = zips[0];
        reasons.push(`郵便番号候補が複数 (${zips.join(', ')})`);
      }
    }
  }
  const townPostalCode = postalCode;
  let postalCodeKind: NormalizeResult['postalCodeKind'] = postalCode ? 'town' : null;
  if (prefecture.value && city.value && building) {
    const special =
      (town.value !== null && findBuildingZip(master, prefecture.value, city.value, town.value, building)) ||
      findOfficeZip(master, prefecture.value, city.value, town.value ?? '', block, building);
    if (special) {
      postalCode = special.zip;
      postalCodeKind = special.kind;
    }
  }
  if (inputZip && postalCode && inputZip !== postalCode && inputZip !== townPostalCode) {
    reasons.push(`入力の郵便番号 ${inputZip} と解決結果 ${postalCode} が不一致`);
  }
  if (!prefecture.value) reasons.push('都道府県を特定できません');
  else if (!city.value) reasons.push('市区町村を特定できません');
  else if (town.value === null) reasons.push('町域を特定できません');
  for (const [name, st] of Object.entries({ 都道府県: prefecture, 市区町村: city, 町域: town })) {
    if (st.method === 'ai' && st.probability < threshold) reasons.push(`${name}の確度が低い (${st.probability.toFixed(2)})`);
  }
  const stats = opts.jev
    ? {
        calls: opts.jev.stats.calls - statsBefore.calls,
        inputTokens: opts.jev.stats.inputTokens - statsBefore.inputTokens,
        latencyMs: Math.round(opts.jev.stats.latencyMs - statsBefore.latencyMs),
      }
    : { calls: 0, inputTokens: 0, latencyMs: 0 };
  const normalized = [prefecture.value ?? '', city.value ?? '', town.value ?? '', block].join('') + (building ? ` ${building}` : '');
  return {
    input: raw,
    normalized,
    postalCode,
    postalCodeKind,
    townPostalCode,
    prefecture: prefecture.value,
    city: city.value,
    town: town.value,
    block,
    building,
    stages: { prefecture, city, town },
    needsReview: reasons.length > 0,
    reasons,
    ai: stats,
  };
}

// ---------------------------------------------------------------------------
// 都道府県
// ---------------------------------------------------------------------------
async function resolvePrefecture(
  rest: string,
  zipRows: ZipRow[] | undefined,
  opts: NormalizeOptions,
  log: (m: string) => void,
): Promise<{ stage: Stage; rest: string }> {
  const { master } = opts;
  const names = master.prefectures.map((p) => p.name);

  // 1. 正式名称で前方一致
  for (const name of names) {
    const consumed = consumePrefix(rest, name);
    if (consumed !== null) return { stage: { value: name, method: 'rule', probability: 1 }, rest: consumed };
  }
  // 2. 郵便番号から一意に決まる
  if (zipRows) {
    const prefs = new Set(zipRows.map((r) => r.prefecture));
    if (prefs.size === 1) {
      const name = [...prefs][0];
      return { stage: { value: name, method: 'zip', probability: 1 }, rest: consumePrefix(rest, name.replace(PREF_SUFFIX, '')) ?? rest };
    }
  }
  // 3. 市区町村名から一意に決まる（都道府県省略）
  const k = key(rest);
  let best: { len: number; pref: string } | null = null;
  for (const [ck, prefs] of master.cityIndex) {
    if (prefs.size === 1 && ck.length >= 2 && k.startsWith(ck) && (!best || ck.length > best.len)) {
      best = { len: ck.length, pref: [...prefs][0] };
    }
  }
  if (best) {
    log(`prefecture inferred from city prefix → ${best.pref}`);
    return { stage: { value: best.pref, method: 'rule', probability: 1 }, rest };
  }
  // 3b. 同名市区町村が複数の都道府県にある: 町域名が一致する側が一つならそれ
  let ambiguous: { len: number; prefs: Set<string>; ck: string } | null = null;
  for (const [ck, prefs] of master.cityIndex) {
    if (prefs.size > 1 && ck.length >= 2 && k.startsWith(ck) && (!ambiguous || ck.length > ambiguous.len)) ambiguous = { len: ck.length, prefs, ck };
  }
  if (ambiguous) {
    const hits = new Set<string>();
    for (const prefName of ambiguous.prefs) {
      const pref = master.prefectures.find((p) => p.name === prefName)!;
      for (const c of pref.cities) {
        const afterCity = cityVariants(c.name, pref.cities.map((x) => x.name)).map((v) => consumePrefix(rest, v)).find((x) => x !== null);
        if (afterCity === undefined || afterCity === null) continue;
        if (c.towns.some((t) => t && consumePrefix(afterCity, t) !== null)) hits.add(prefName);
      }
    }
    if (hits.size === 1) {
      const p = [...hits][0];
      log(`prefecture disambiguated by town match → ${p} (candidates: ${[...ambiguous.prefs].join(',')})`);
      return { stage: { value: p, method: 'rule', probability: 1 }, rest };
    }
  }
  // 4. 「東京」「大阪」など接尾辞なし
  for (const name of names) {
    const short = name.replace(PREF_SUFFIX, '');
    const consumed = consumePrefix(rest, short);
    if (consumed !== null) return { stage: { value: name, method: 'rule', probability: 1 }, rest: consumed };
  }
  // 5. Jev に選ばせる
  if (!opts.jev) return { stage: none(), rest };
  const r = await opts.jev.choose({
    state: { address: rest },
    instructions:
      '入力された日本の住所 (address) が属する都道府県を選んでください。都道府県名が省略されている場合は市区町村名・地名から推定してください。日本の住所でない、または特定できない場合は該当なしを選んでください。',
    options: names,
    noneDescription: '特定できない・日本の住所ではない',
  });
  log(`prefecture via Jev → ${r.choice} (p=${r.probability})`);
  const stage = toStage(r);
  const consumed = r.choice ? (consumePrefix(rest, r.choice) ?? consumePrefix(rest, r.choice.replace(PREF_SUFFIX, ''))) : null;
  return { stage, rest: consumed ?? rest };
}

// ---------------------------------------------------------------------------
// 市区町村
// ---------------------------------------------------------------------------
async function resolveCity(
  rest: string,
  pref: Master['prefectures'][number],
  zipRows: ZipRow[] | undefined,
  opts: NormalizeOptions,
  log: (m: string) => void,
): Promise<{ stage: Stage; rest: string }> {
  const zipCities = zipRows ? new Set(zipRows.filter((r) => r.prefecture === pref.name).map((r) => r.city)) : null;
  const candidates = zipCities && zipCities.size > 0 ? pref.cities.filter((c) => zipCities.has(c.name)) : pref.cities;

  // 1. ルール: 前方一致（最長）。郡名省略・「ケ/ヶ」等の揺れは key() が吸収。
  let best: { city: string; rest: string; len: number } | null = null;
  for (const c of candidates) {
    for (const v of cityVariants(c.name, pref.cities.map((x) => x.name))) {
      const consumed = consumePrefix(rest, v);
      if (consumed !== null && (!best || key(v).length > best.len)) best = { city: c.name, rest: consumed, len: key(v).length };
    }
  }
  if (best) {
    return { stage: { value: best.city, method: candidates.length === 1 && zipCities ? 'zip' : 'rule', probability: 1 }, rest: best.rest };
  }
  // 2. 郵便番号で一意
  if (zipCities && zipCities.size === 1) {
    const cityName = [...zipCities][0];
    return { stage: { value: cityName, method: 'zip', probability: 1 }, rest: consumeAnywhere(rest, cityVariants(cityName, [])) ?? rest };
  }
  // 3. Jev
  if (!opts.jev) return { stage: none(), rest };
  const r = await fuzzyChoose({
    jev: opts.jev,
    label: 'city',
    state: { prefecture: pref.name, address: rest },
    instructions:
      `${pref.name}内の住所 (address) が属する市区町村を選んでください。郡名の省略、旧字体・異体字、ひらがな表記（各候補の読みを参照）、誤字・脱字・文字の入替、送り仮名の揺れ、旧市町村名（合併前）は同一の市区町村とみなしてください。政令指定都市は区まで特定してください。address に市区町村らしい文字列が全くない場合のみ該当なしを選んでください。`,
    candidates: candidates.map((c) => c.name),
    noneDescription: 'address に市区町村名らしい部分が無い・どの候補とも全く似ていない',
    head: rest,
    kanaOf: (c) => opts.master.kana.get(`${pref.name}|${c}`),
    log,
  });
  log(`city via Jev → ${r.choice} (p=${r.probability})`);
  const stage = toStage(r);
  const consumed = r.choice ? consumeAnywhere(rest, cityVariants(r.choice, [])) : null;
  return { stage, rest: consumed ?? rest };
}

function cityVariants(name: string, allInPref: string[]): string[] {
  const v = [name];
  const gun = name.match(/^(.+?郡)(.+)$/);
  if (gun) v.push(gun[2]);
  const ward = name.match(/^(.+?市)(.+区)$/);
  if (ward) {
    // 区名単独は都道府県内で一意なときだけ許可
    const dup = allInPref.filter((n) => n !== name && n.endsWith(ward[2])).length;
    if (dup === 0) v.push(ward[2]);
    v.push(ward[1] + ward[2]);
  }
  return v;
}

// ---------------------------------------------------------------------------
// 町域
// ---------------------------------------------------------------------------
async function resolveTown(
  rest: string,
  fullInput: string,
  prefName: string,
  city: Master['prefectures'][number]['cities'][number],
  zipRows: ZipRow[] | undefined,
  opts: NormalizeOptions,
  log: (m: string) => void,
): Promise<{ stage: Stage; rest: string }> {
  rest = rest.replace(/^[\s,、。・]+/, '');
  const zipTowns = zipRows ? new Set(zipRows.filter((r) => r.city === city.name).map((r) => r.town)) : null;
  const towns = city.towns;

  // 町域なしで直接番地（または入力が市区町村で終わっている）
  const hasNoTownArea = opts.master.byPlace.has(placeKey(prefName, city.name, ''));
  if ((rest === '' || /^\d/.test(key(rest))) && hasNoTownArea && (!zipTowns || zipTowns.has(''))) {
    return { stage: { value: '', method: 'rule', probability: 1 }, rest };
  }

  // 1. ルール: 最長前方一致
  let best: { town: string; rest: string; len: number } | null = null;
  for (const t of towns) {
    for (const v of townVariants(t)) {
      const consumed = consumePrefix(rest, v);
      if (consumed !== null && (!best || key(v).length > best.len)) best = { town: t, rest: consumed, len: key(v).length };
    }
  }
  // 1b. 京都市: 「○○通△△上る 町名」のように通り名が先行するので、任意位置の最長一致を採る
  if (!best && /^京都市/.test(city.name)) {
    for (const t of towns) {
      if (key(t).length < 3) continue;
      const consumed = consumeAnywhere(rest, [t]);
      if (consumed !== null && (!best || key(t).length > best.len)) best = { town: t, rest: consumed, len: key(t).length };
    }
    if (best) log(`town via Kyoto street-name rule → ${best.town}`);
  }
  const kanaOf = (t: string) => opts.master.kana.get(placeKey(prefName, city.name, t));
  const state = { prefecture: prefName, city: city.name, remaining_text: rest, full_address: fullInput };
  const instructions =
    `${prefName}${city.name}内の住所について、remaining_text（市区町村名より後ろの部分）が指す町域（町名・大字）を選んでください。` +
    '旧字体・異体字、ひらがな/カタカナ表記（各候補の読みを参照）、送り仮名や「ケ/ヶ/が」「ノ/之」の揺れ、一文字程度の誤字・脱字・文字の入替、略記、京都市の通り名表記（〇〇通△△上る等）は同じ町域とみなしてください。' +
    '丁目・番地・号・建物名・部屋番号は無視してください。町域名が無く直接番地が続く場合、または remaining_text の地名がどの候補とも全く似ていない場合のみ該当なしを選んでください。';
  const noneDescription = '町域名が無い（直接番地が続く）・候補のどれとも全く似ていない';

  // 文字列で町域が特定できたら郵便番号と矛盾していてもそれを採る（矛盾は finish() で要レビューになる）
  if (best) {
    // 町域の後ろに番地ではない文字が続く（例: 宮町西2-24 → 宮町 + 西2-24）ときは、ルール一致が誤りの可能性があるので Jev に検証させる
    const suspicious = best.rest !== '' && !/^\d/.test(key(best.rest));
    if (opts.jev && suspicious) {
      const shortlist = rankCandidates(towns, rest, kanaOf).slice(0, 30);
      if (!shortlist.includes(best.town)) shortlist.unshift(best.town);
      const r = await opts.jev.choose({
        state: { ...state, rule_candidate: best.town },
        instructions:
          instructions +
          ' rule_candidate は前方一致で見つかった候補ですが、remaining_text 全体を見て、文字の入替や誤字を考慮すると別の候補の方が適切ならそれを選んでください。',
        options: shortlist,
        describe: (o) => describeKana(kanaOf(o)),
        noneDescription,
        allowNone: false,
      });
      log(`town rule=${best.town} verified by Jev → ${r.choice} (p=${r.probability})`);
      if (r.choice && r.choice !== best.town && r.probability >= 0.7) {
        const stage = toStage(r);
        return { stage, rest: consumeAnywhere(rest, townVariants(r.choice)) ?? consumeToDigits(rest) ?? rest };
      }
      if (r.choice === best.town) return { stage: toStage(r), rest: best.rest };
    }
    return { stage: { value: best.town, method: 'rule', probability: 1 }, rest: best.rest };
  }
  // 2. 郵便番号で一意
  if (zipTowns && zipTowns.size === 1) {
    const t = [...zipTowns][0];
    return { stage: { value: t, method: 'zip', probability: 1 }, rest: t ? (consumeAnywhere(rest, townVariants(t)) ?? consumeToDigits(rest) ?? rest) : rest };
  }
  // 3. Jev
  if (!opts.jev) return { stage: none(), rest };
  const candidates = zipTowns && zipTowns.size > 0 ? towns.filter((t) => zipTowns.has(t)) : towns;
  const r = await fuzzyChoose({ jev: opts.jev, label: 'town', state, instructions, candidates, noneDescription, head: rest, kanaOf, log });
  log(`town via Jev → ${r.choice} (p=${r.probability})`);
  const stage = toStage(r);
  if (r.choice === null) {
    // 該当なし: 町域なしとして扱い、番地までを消費
    if (hasNoTownArea && /^\d/.test(key(rest))) stage.value = '';
    return { stage, rest: consumeToDigits(rest) ?? rest };
  }
  const consumed = consumeAnywhere(rest, townVariants(r.choice)) ?? consumeToDigits(rest) ?? rest;
  return { stage, rest: consumed };
}

// ---------------------------------------------------------------------------
// Jev への問い合わせ（誤字・脱字耐性付き）
// ---------------------------------------------------------------------------
function describeKana(k: string | undefined): string | null {
  return k ? `読み: ${k}` : null;
}

/** 入力の先頭（番地より前）との文字/読み類似度で候補を並べる。 */
function rankCandidates(candidates: string[], rest: string, kanaOf: (c: string) => string | undefined): string[] {
  const headRaw = rest.replace(/[\d〇一二三四五六七八九十百千]+(丁目|番地|番|号|-).*$/, '').replace(/\s.*$/, '');
  const head = key(headRaw).slice(0, 12);
  const headKana = hasKana(headRaw) ? toKatakana(headRaw).replace(/[^\u30a1-\u30f6\u30fc]/g, '') : '';
  return candidates
    .map((t) => {
      const k = key(t);
      let s = Math.max(bigramSimilarity(head, k), charOverlap(head, k) * 0.8);
      const kana = kanaOf(t);
      if (headKana && kana) s = Math.max(s, bigramSimilarity(headKana, kana));
      return { t, s };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}

async function fuzzyChoose(p: {
  jev: Jev;
  label: string;
  state: Record<string, string>;
  instructions: string;
  candidates: string[];
  noneDescription: string;
  head: string;
  kanaOf: (c: string) => string | undefined;
  log: (m: string) => void;
}): Promise<ChoiceResult> {
  const describe = (o: string) => describeKana(p.kanaOf(o));
  const ranked = rankCandidates(p.candidates, p.head, p.kanaOf);

  // 1 周目: 該当なしを含めて選ばせる（候補が多いときは類似度上位 200 件 → 外れたら全件チャンク）
  let r: ChoiceResult;
  const base = { state: p.state, instructions: p.instructions, describe, noneDescription: p.noneDescription };
  if (p.candidates.length <= 254) {
    r = await p.jev.choose({ ...base, options: p.candidates });
  } else {
    r = await p.jev.choose({ ...base, options: ranked.slice(0, 200) });
    if (!r.choice || r.probability < 0.6) {
      p.log(`${p.label}: similarity shortlist missed (p=${r.probability}); evaluating all ${p.candidates.length} candidates`);
      r = await p.jev.choose({ ...base, options: p.candidates });
    }
  }
  if (r.choice && r.probability >= 0.7) return r;

  // 2 周目: 誤字・脱字を前提に、類似度上位の少数候補から必ず 1 つ選ばせる
  const shortlist = ranked.slice(0, 30);
  if (r.choice && !shortlist.includes(r.choice)) shortlist.push(r.choice);
  if (shortlist.length < 2) return r;
  const r2 = await p.jev.choose({
    state: { ...p.state, first_pass: r.choice ?? '該当なし' },
    instructions:
      p.instructions +
      ' 入力には 1 文字程度の誤字・脱字・文字の入替、またはひらがな表記が含まれている可能性が高いです。候補の中で文字や読みが最も近いものを必ず 1 つ選んでください。',
    options: shortlist,
    describe,
    noneDescription: p.noneDescription,
    allowNone: false,
  });
  p.log(`${p.label}: fuzzy second pass → ${r2.choice} (p=${r2.probability}); first pass ${r.choice} (p=${r.probability})`);
  if (r2.choice && r2.probability >= 0.6 && r2.probability > r.probability) return r2;
  return r;
}

function townVariants(t: string): string[] {
  const v = [t];
  const m = t.match(/^(大字|字)(.+)$/);
  if (m) v.push(m[2]);
  return v;
}

// ---------------------------------------------------------------------------
// 番地・建物
// ---------------------------------------------------------------------------
const NUM_TOKEN = /^(\d+|[〇零一二三四五六七八九十百千]+)\s*(丁目|丁|番地の|番地|番|号室|号|の|ノ|-)?\s*/;

export function parseBlockAndBuilding(rest: string): { block: string; building: string } {
  let s = rest.replace(/^[\s,、。・-]+/, '');
  const nums: string[] = [];
  let roomSuffix = '';
  while (s.length > 0) {
    const m = s.match(NUM_TOKEN);
    if (!m) break;
    const n = /^\d+$/.test(m[1]) ? m[1] : String(kanjiToNumber(m[1]) ?? m[1]);
    // 「一番町」のような町名残りを誤って数値化しないため、漢数字は区切り記号が続く場合のみ
    if (!/^\d+$/.test(m[1]) && !m[2] && nums.length === 0) break;
    nums.push(n);
    s = s.slice(m[0].length);
    if (m[2] === '号室') {
      roomSuffix = `${n}号室`;
      nums.pop();
      break;
    }
    if (!m[2] && !/^[-\d]/.test(s)) break;
  }
  const block = nums.join('-');
  let building = s.replace(/^[\s,、。・-]+/, '').trim();
  if (roomSuffix) building = building ? `${building} ${roomSuffix}` : roomSuffix;
  if (!block && !/^\d/.test(rest)) return { block: '', building: rest.trim() };
  return { block, building };
}

// ---------------------------------------------------------------------------
// 高層ビル階層別番号 / 大口事業所個別番号
// ---------------------------------------------------------------------------
function findBuildingZip(master: Master, pref: string, city: string, town: string, building: string): { zip: string; kind: 'building' } | null {
  const rows = master.buildings.get(placeKey(pref, city, town));
  if (!rows) return null;
  const bk = key(building);
  const floorM = building.match(/(\d+)\s*(階|F)\b/i) ?? building.match(/(\d+)(階|F)/i);
  const floor = floorM ? Number(floorM[1]) : null;
  const matched = rows.filter((r) => bk.includes(key(r.building)));
  if (matched.length === 0) return null;
  const hit = matched.find((r) => r.floor === floor) ?? (floor === null ? matched.find((r) => r.floor === null) : undefined);
  return hit ? { zip: hit.zip, kind: 'building' } : null;
}

function findOfficeZip(master: Master, pref: string, city: string, town: string, block: string, building: string): { zip: string; kind: 'office' } | null {
  const rows = master.offices.get(`${pref}|${city}`);
  if (!rows) return null;
  const bk = key(building);
  if (bk.length < 2) return null;
  const detailKey = key(`${town}${block}`);
  const hits = rows.filter((r) => {
    const nk = key(r.name);
    if (!(bk.includes(nk) || (nk.length >= 4 && nk.includes(bk)))) return false;
    // 同名事業所の誤マッチを防ぐため、町域＋番地の先頭が一致するものに限る
    const dk = key(r.detail);
    return dk.includes(detailKey) || detailKey.startsWith(dk) || dk.includes(key(town) + key(block.split('-')[0] ?? ''));
  });
  return hits.length === 1 ? { zip: hits[0].zip, kind: 'office' } : null;
}

// ---------------------------------------------------------------------------
// 郵便番号の丁目補正
// ---------------------------------------------------------------------------
function refineZipByChome(master: Master, pref: string, city: string, town: string, block: string, building: string): string | null {
  const chome = Number(block.split('-')[0]);
  const restKey = key(block + building);
  const hits = new Set<string>();
  for (const r of master.byPlace.get(placeKey(pref, city, town)) ?? []) {
    const paren = r.townRaw.normalize('NFKC').match(/\((.+)\)/);
    if (!paren) continue;
    const spec = paren[1];
    if (block && Number.isFinite(chome) && parenIncludesChome(spec, chome)) hits.add(r.zip);
    // 「本通（北）」のような文字のいすれかが残りテキストに含まれる
    else if (!/\d/.test(spec) && spec.split(/[、,]/).some((p) => p && restKey.includes(key(p)))) hits.add(r.zip);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

function parenIncludesChome(spec: string, chome: number): boolean {
  if (!/丁目/.test(spec)) return false;
  const body = spec.replace(/丁目.*$/, '');
  for (const part of body.split(/[、,]/)) {
    const range = part.match(/^(\d+)\s*[-〜~]\s*(\d+)$/);
    if (range) {
      if (chome >= Number(range[1]) && chome <= Number(range[2])) return true;
    } else if (/^\d+$/.test(part) && Number(part) === chome) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function toStage(r: ChoiceResult): Stage {
  return {
    value: r.choice,
    method: 'ai',
    probability: r.probability,
    confidence: r.confidence,
    alternatives: r.top.slice(0, 3),
  };
}

/** rest の先頭が name（key() 比較）で始まるなら、それを取り除いた残りを返す。 */
function consumePrefix(rest: string, name: string): string | null {
  const target = key(name);
  if (!target) return null;
  const chars = Array.from(rest);
  for (let i = 1; i <= chars.length; i++) {
    const k = key(chars.slice(0, i).join(''));
    if (k === target) return chars.slice(i).join('').replace(/^[\s,、。・]+/, '');
    if (k.length > target.length) break;
  }
  return null;
}

/** rest 内の任意位置に name があれば、その直後以降を返す。 */
function consumeAnywhere(rest: string, names: string[]): string | null {
  const chars = Array.from(rest);
  for (const name of names) {
    const target = key(name);
    if (!target) continue;
    for (let i = 0; i < chars.length; i++) {
      for (let j = i + 1; j <= chars.length; j++) {
        const k = key(chars.slice(i, j).join(''));
        if (k === target) return chars.slice(j).join('').replace(/^[\s,、。・]+/, '');
        if (k.length > target.length) break;
      }
    }
  }
  return null;
}

/** 最初の数字（算用数字/丁目直前の漢数字）が現れる位置まで消費する。 */
function consumeToDigits(rest: string): string | null {
  const m = rest.match(/(\d|[〇一二三四五六七八九十]+(?=丁目|番|号))/);
  if (!m || m.index === undefined) return null;
  return rest.slice(m.index);
}
