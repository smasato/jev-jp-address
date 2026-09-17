import { readFileSync } from 'node:fs';
import { key } from './text.js';

export interface ZipRow {
  zip: string;
  prefecture: string;
  city: string;
  /** 括弧などを除いた町域名。町域なし（「以下に掲載がない場合」等）は空文字。 */
  town: string;
  /** KEN_ALL 原文の町域名 */
  townRaw: string;
}

/** 高層ビルの階層別郵便番号 */
export interface BuildingRow {
  zip: string;
  building: string;
  /** null = 地階・階層不明 */
  floor: number | null;
}

/** 大口事業所個別番号 (JIGYOSYO.CSV) */
export interface OfficeRow {
  zip: string;
  name: string;
  detail: string;
}

export interface City {
  name: string;
  towns: string[];
}

export interface Prefecture {
  name: string;
  cities: City[];
}

export interface Master {
  prefectures: Prefecture[];
  rows: ZipRow[];
  byZip: Map<string, ZipRow[]>;
  /** key(city) → 都道府県名の集合 */
  cityIndex: Map<string, Set<string>>;
  /** `${pref}|${city}|${town}` → rows */
  byPlace: Map<string, ZipRow[]>;
  /** `${pref}|${city}|${town}` → 階層別番号 */
  buildings: Map<string, BuildingRow[]>;
  /** `${pref}|${city}` → 大口事業所 */
  offices: Map<string, OfficeRow[]>;
  /** `${pref}|${city}` / placeKey → カタカナ読み */
  kana: Map<string, string>;
}

export function placeKey(pref: string, city: string, town: string): string {
  return `${pref}|${city}|${town}`;
}

const BUILDING_RE = /\((\d+階|地階・階層不明)\)$/;

/** KEN_ALL 町域名を、マッチング用の町域名へ整形する。 */
export function cleanTown(raw: string): string | null {
  const t = raw.normalize('NFKC');
  if (t === '以下に掲載がない場合') return '';
  if (t.endsWith('の次に番地がくる場合')) return '';
  if (/^[^(]+一円$/.test(t)) return '';
  if (BUILDING_RE.test(t)) return null; // 高層ビル階層レコードは buildings へ
  const base = t.replace(/\(.*$/, '').trim();
  if (base === '') return '';
  return base;
}

/** 「渋谷渋谷スクランブルスクエア（１５階）」→ { town: 渋谷, building: 渋谷スクランブルスクエア, floor: 15 } */
export function parseBuildingRow(raw: string, townsInCity: Iterable<string>): { town: string; building: string; floor: number | null } | null {
  const t = raw.normalize('NFKC');
  const m = t.match(/^(.*)\((\d+階|地階・階層不明)\)$/);
  if (!m) return null;
  const body = m[1];
  const fm = m[2].match(/^(\d+)階$/);
  const floor = fm ? Number(fm[1]) : null;
  let best = '';
  for (const town of townsInCity) {
    if (town && body.startsWith(town) && town.length > best.length && town.length < body.length) best = town;
  }
  if (!best) return null;
  return { town: best, building: body.slice(best.length), floor };
}

export function loadMaster(csvPath: string, officeCsvPath?: string): Master {
  const text = readFileSync(csvPath, 'utf8');
  const buildingRaw: Array<{ zip: string; prefecture: string; city: string; townRaw: string }> = [];
  const rows: ZipRow[] = [];
  const byZip = new Map<string, ZipRow[]>();
  const prefMap = new Map<string, Map<string, Set<string>>>();
  const cityIndex = new Map<string, Set<string>>();
  const byPlace = new Map<string, ZipRow[]>();
  const kana = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cols = parseCsvLine(line);
    if (cols.length < 9) continue;
    const zip = cols[2];
    const prefecture = cols[6];
    const city = cols[7];
    const townRaw = cols[8];
    const town = cleanTown(townRaw);
    if (town === null) {
      buildingRaw.push({ zip, prefecture, city, townRaw });
      continue;
    }
    const row: ZipRow = { zip, prefecture, city, town, townRaw };
    rows.push(row);
    kana.set(`${prefecture}|${city}`, cols[4].normalize('NFKC'));
    if (town) {
      const pk0 = placeKey(prefecture, city, town);
      if (!kana.has(pk0)) kana.set(pk0, cols[5].normalize('NFKC').replace(/\(.*$/, ''));
    }
    let z = byZip.get(zip);
    if (!z) byZip.set(zip, (z = []));
    z.push(row);
    const pk = placeKey(prefecture, city, town);
    let pl = byPlace.get(pk);
    if (!pl) byPlace.set(pk, (pl = []));
    pl.push(row);
    let cities = prefMap.get(prefecture);
    if (!cities) prefMap.set(prefecture, (cities = new Map()));
    let towns = cities.get(city);
    if (!towns) cities.set(city, (towns = new Set()));
    if (town) towns.add(town);
    const ck = key(city);
    let ps = cityIndex.get(ck);
    if (!ps) cityIndex.set(ck, (ps = new Set()));
    ps.add(prefecture);
    // 郡を除いた町村名でも引けるようにする
    const m = city.match(/^(.+?郡)(.+)$/);
    if (m) {
      const k2 = key(m[2]);
      let ps2 = cityIndex.get(k2);
      if (!ps2) cityIndex.set(k2, (ps2 = new Set()));
      ps2.add(prefecture);
    }
  }

  const prefectures: Prefecture[] = [];
  for (const [name, cities] of prefMap) {
    prefectures.push({
      name,
      cities: Array.from(cities, ([cname, towns]) => ({ name: cname, towns: Array.from(towns) })),
    });
  }
  const buildings = new Map<string, BuildingRow[]>();
  for (const b of buildingRaw) {
    const towns = prefMap.get(b.prefecture)?.get(b.city);
    if (!towns) continue;
    const parsed = parseBuildingRow(b.townRaw, towns);
    if (!parsed) continue;
    const pk = placeKey(b.prefecture, b.city, parsed.town);
    let list = buildings.get(pk);
    if (!list) buildings.set(pk, (list = []));
    list.push({ zip: b.zip, building: parsed.building, floor: parsed.floor });
  }

  const offices = new Map<string, OfficeRow[]>();
  if (officeCsvPath) {
    for (const line of readFileSync(officeCsvPath, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      const c = parseCsvLine(line);
      if (c.length < 8) continue;
      const k = `${c[3]}|${c[4]}`;
      let list = offices.get(k);
      if (!list) offices.set(k, (list = []));
      list.push({ zip: c[7], name: c[2].normalize('NFKC'), detail: `${c[5]}${c[6]}`.normalize('NFKC') });
    }
  }

  return { prefectures, rows, byZip, cityIndex, byPlace, buildings, offices, kana };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function findZips(master: Master, prefecture: string, city: string, town: string): string[] {
  const rows = master.byPlace.get(placeKey(prefecture, city, town)) ?? [];
  return Array.from(new Set(rows.map((r) => r.zip)));
}
