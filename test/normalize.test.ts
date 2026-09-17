import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { cleanTown, loadMaster, parseBuildingRow, type Master } from '../src/master.js';
import { normalizeAddress, parseBlockAndBuilding } from '../src/pipeline.js';
import { extractZip, kanjiToNumber, key, preprocess } from '../src/text.js';

const ROOT = resolve(import.meta.dirname, '..');
const KEN_ALL = resolve(ROOT, 'data/utf_ken_all.csv');
const JIGYOSYO = resolve(ROOT, 'data/jigyosyo_utf8.csv');

describe('text', () => {
  it('kanjiToNumber', () => {
    assert.equal(kanjiToNumber('三'), 3);
    assert.equal(kanjiToNumber('二十五'), 25);
    assert.equal(kanjiToNumber('百一'), 101);
    assert.equal(kanjiToNumber('三〇一'), 301);
    assert.equal(kanjiToNumber('abc'), null);
  });
  it('key absorbs variants', () => {
    assert.equal(key('千駄ケ谷'), key('千駄ヶ谷'));
    assert.equal(key('霞ヶ関'), key('霞が関'));
    assert.equal(key('丸ノ内'), key('丸の内'));
    assert.equal(key('竜ケ崎'), key('龍ケ崎'));
    assert.equal(key('塩釜'), key('塩竈'));
    assert.equal(key('北一条西'), key('北1条西'));
    assert.equal(key('三丁目'), key('3丁目'));
  });
  it('preprocess', () => {
    assert.equal(preprocess('東京都　千代田区 丸の内１－１－１'), '東京都 千代田区 丸の内1-1-1');
    assert.equal(preprocess('丸ノ内一ー一ー一'), '丸ノ内一-一-一');
  });
  it('extractZip', () => {
    assert.deepEqual(extractZip('〒100-0005 東京都千代田区丸の内1-1'), { zip: '1000005', rest: '東京都千代田区丸の内1-1' });
    assert.deepEqual(extractZip('1000005東京都'), { zip: '1000005', rest: '東京都' });
    assert.equal(extractZip('東京都千代田区1-1-1').zip, null);
  });
});

describe('master helpers', () => {
  it('cleanTown special records', () => {
    assert.equal(cleanTown('以下に掲載がない場合'), '');
    assert.equal(cleanTown('利島村一円'), '');
    assert.equal(cleanTown('大通西（１〜１９丁目）'), '大通西');
    assert.equal(cleanTown('渋谷渋谷スクランブルスクエア（１５階）'), null);
  });
  it('parseBuildingRow', () => {
    assert.deepEqual(parseBuildingRow('渋谷渋谷スクランブルスクエア（１５階）', ['渋谷', '神南']), {
      town: '渋谷',
      building: '渋谷スクランブルスクエア',
      floor: 15,
    });
    assert.equal(parseBuildingRow('渋谷', ['渋谷']), null);
  });
});

describe('parseBlockAndBuilding', () => {
  it('kanji/arabic mix', () => {
    assert.deepEqual(parseBlockAndBuilding('三丁目12番14号 ケンオール株式会社'), { block: '3-12-14', building: 'ケンオール株式会社' });
    assert.deepEqual(parseBlockAndBuilding('1-16-1 港区芝浦港南地区総合支所'), { block: '1-16-1', building: '港区芝浦港南地区総合支所' });
    assert.deepEqual(parseBlockAndBuilding('一-一-一'), { block: '1-1-1', building: '' });
  });
});

describe('pipeline (rule only, requires data/)', { skip: !existsSync(KEN_ALL) }, () => {
  let master: Master;
  const load = () => (master ??= loadMaster(KEN_ALL, existsSync(JIGYOSYO) ? JIGYOSYO : undefined));

  it('basic + omitted prefecture', async () => {
    const r = await normalizeAddress('千代田区麹町三丁目12番14号', { master: load(), jev: null });
    assert.equal(r.normalized, '東京都千代田区麹町3-12-14');
    assert.equal(r.postalCode, '1020083');
    assert.equal(r.needsReview, false);
  });
  it('chome-dependent postal code', async () => {
    const r = await normalizeAddress('東京都港区芝浦1-16-1', { master: load(), jev: null });
    assert.equal(r.postalCode, '1050023');
    const r2 = await normalizeAddress('東京都港区芝浦3-1-1', { master: load(), jev: null });
    assert.equal(r2.postalCode, '1080023');
  });
  it('kyoto street name', async () => {
    const r = await normalizeAddress('京都市中京区西堀川通御池下る西三坊堀川町521', { master: load(), jev: null });
    assert.equal(r.town, '西三坊堀川町');
    assert.equal(r.postalCode, '6048265');
  });
  it('high-rise floor code keeps town code', async () => {
    const r = await normalizeAddress('東京都渋谷区渋谷2-24-12 渋谷スクランブルスクエア15階', { master: load(), jev: null });
    assert.equal(r.postalCode, '1506115');
    assert.equal(r.postalCodeKind, 'building');
    assert.equal(r.townPostalCode, '1500002');
  });
  it('no-town municipality', async () => {
    const r = await normalizeAddress('茨城県竜ケ崎市3710', { master: load(), jev: null });
    assert.equal(r.city, '龍ケ崎市');
    assert.equal(r.town, '');
    assert.equal(r.postalCode, '3010000');
  });
  it('same-name city disambiguated by town', async () => {
    const r = await normalizeAddress('府中市宮西町2-24', { master: load(), jev: null });
    assert.equal(r.prefecture, '東京都');
    assert.equal(r.postalCode, '1830022');
  });
  it('zip conflicting with text is flagged', async () => {
    const r = await normalizeAddress('〒1000005 東京都千代田区大手町1-1-1', { master: load(), jev: null });
    assert.equal(r.town, '大手町');
    assert.equal(r.needsReview, true);
  });
});
