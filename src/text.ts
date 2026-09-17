const KANJI_DIGITS: Record<string, number> = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 漢数字（十・百を含む、千まで）を算用数字に変換する。 */
export function kanjiToNumber(s: string): number | null {
  if (!/^[〇零一二三四五六七八九十百千]+$/.test(s)) return null;
  let total = 0;
  let current = 0;
  for (const ch of s) {
    if (ch in KANJI_DIGITS) {
      current = current * 10 + KANJI_DIGITS[ch];
    } else if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch === '千') {
      total += (current || 1) * 1000;
      current = 0;
    }
  }
  return total + current;
}

const OLD_TO_NEW: Record<string, string> = {
  ヶ: 'ケ', が: 'ケ', ガ: 'ケ', ヵ: 'ケ',
  之: 'ノ', の: 'ノ', 乃: 'ノ',
  檜: '桧', 龍: '竜', 嶋: '島', 嶌: '島', 澁: '渋', 櫻: '桜', 邊: '辺', 邉: '辺',
  齋: '斉', 齊: '斉', 斎: '斉', 條: '条', 圓: '円', 國: '国', 學: '学', 榮: '栄',
  廣: '広', 濱: '浜', 惠: '恵', 會: '会', 舘: '館', 藪: '薮', 籔: '薮', 曾: '曽',
  眞: '真', 壽: '寿', 萬: '万', 驒: '騨', 鷗: '鴎', 靱: '靭', 靫: '靭', 內: '内',
  淸: '清', 黑: '黒', 塚: '塚', 峯: '峰', 亀: '亀', 龜: '亀', 瀨: '瀬', 槇: '槙',
  繩: '縄', 繁: '繁', 檮: '梼', 埜: '野', 𡈽: '土', 桒: '桑', 芦: '芦', 蘆: '芦',
  竈: '釜', 嵜: '崎', 﨑: '崎', 鷄: '鶏', 穗: '穂', 瀧: '滝', 髙: '高', 濵: '浜', 冨: '富',
  '〜': '-', '～': '-', '−': '-', '―': '-', '‐': '-', '－': '-',
};

/** 比較用キー: NFKC 正規化 + 全角→半角 + 異体字/揺れ吸収 + 空白削除。 */
export function key(s: string): string {
  let out = s.normalize('NFKC').replace(/[\s　]+/g, '');
  out = Array.from(out)
    .map((c) => OLD_TO_NEW[c] ?? c)
    .join('');
  // 「大字」「字」「丁目」直前の漢数字を算用数字に
  out = out.replace(/^(大字|字)/, '');
  out = out.replace(/([〇零一二三四五六七八九十百千]+)(?=(丁目|丁|番地|番|号|条|線|区|号))/g, (m) =>
    String(kanjiToNumber(m) ?? m),
  );
  out = out.replace(/(\d+)丁目/g, '$1');
  out = out.replace(/(\d+)(丁|番地|番|号|条|線)/g, '$1');
  out = out.replace(/(\d+)-(\d+)/g, '$1$2');
  return out.toLowerCase();
}

/** 入力住所の前処理: NFKC、全角英数→半角、区切り記号統一。 */
export function preprocess(raw: string): string {
  let s = raw.normalize('NFKC');
  s = s.replace(/[〜～−―‐－]/g, '-');
  // 「一ー一ー一」のように長音符で区切られた漢数字の番地
  s = s.replace(/([〇一二三四五六七八九十百千\d])ー(?=[〇一二三四五六七八九十百千\d])/g, '$1-');
  s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.replace(/[\s　]+/g, ' ').trim();
  s = s.replace(/^(日本|JAPAN|Japan)[,、\s]*/i, '');
  return s;
}

const ZIP_RE = /〒?\s*(\d{3})-?(\d{4})(?![-\d])/;

/** 郵便番号を抽出し、除去した残りを返す。 */
export function extractZip(s: string): { zip: string | null; rest: string } {
  const m = s.match(ZIP_RE);
  if (!m) return { zip: null, rest: s };
  return { zip: m[1] + m[2], rest: (s.slice(0, m.index) + ' ' + s.slice(m.index! + m[0].length)).trim() };
}

/** ひらがな→カタカナ（読み比較用） */
export function toKatakana(s: string): string {
  return s.normalize('NFKC').replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

export function hasKana(s: string): boolean {
  return /[\u3041-\u3096\u30a1-\u30f6]/.test(s);
}

/** 文字 bigram 集合による類似度 (Dice)。 */
export function bigramSimilarity(a: string, b: string): number {
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

function grams(s: string): Set<string> {
  const set = new Set<string>();
  const chars = Array.from(s);
  if (chars.length === 1) set.add(chars[0]);
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

/** 文字集合の重なり率（部分一致・並び替えに強い） */
export function charOverlap(a: string, b: string): number {
  const sa = new Set(Array.from(a));
  const sb = new Set(Array.from(b));
  if (sb.size === 0) return 0;
  let inter = 0;
  for (const c of sb) if (sa.has(c)) inter++;
  return inter / sb.size;
}
