/**
 * Unit tests for getOhlcv() newest-N reads and `before` history windows.
 * Pure unit — no TradingView Desktop required. The page-context JS that
 * getOhlcv() sends over CDP is executed in a vm sandbox against a fake
 * mainSeries(), so window selection and history paging run for real.
 *
 * Run: node --test tests/ohlcv_history.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getOhlcv } from '../src/core/data.js';

const DAY = 86400;
const T0 = 1500000000; // time of the oldest bar TradingView can deliver

// Fake main series: `total` bars of history exist, the newest `loaded` are in
// bars(). requestMoreData(n) prepends up to n older bars unless `stalled`.
// `available` overrides requestMoreDataAvailable(): a value, or 'throw'.
function fakeChart({ total = 3000, loaded = 300, step = DAY, stalled = false, available } = {}) {
  const st = { total, loaded, requests: 0, availabilityChecks: 0 };
  const timeAt = (i) => T0 + i * step;
  const bars = {
    firstIndex: () => st.total - st.loaded,
    lastIndex: () => st.total - 1,
    size: () => st.loaded,
    valueAt: (i) => (i >= st.total - st.loaded && i < st.total && Number.isInteger(i)
      ? [timeAt(i), 100 + i, 101 + i, 99 + i, 100.5 + i, 10] : null),
  };
  const mainSeries = {
    bars: () => bars,
    requestMoreDataAvailable: () => {
      st.availabilityChecks++;
      if (available === 'throw') throw new Error('not a function');
      return available !== undefined ? available : st.loaded < st.total;
    },
    requestMoreData: (n) => { st.requests++; if (!stalled) st.loaded = Math.min(st.total, st.loaded + n); },
  };
  const window = {
    TradingViewApi: { _activeChartWidgetWV: { value: () => ({ _chartWidget: { model: () => ({ mainSeries: () => mainSeries }) } }) } },
  };
  const calls = [];
  const sleeps = [];
  // Like CDP returnByValue: the result crosses back as plain JSON.
  const evaluate = async (expr) => {
    calls.push(expr);
    const v = vm.runInNewContext(expr, { window });
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  };
  const sleep = async (ms) => { sleeps.push(ms); };
  return {
    st, timeAt, calls, sleeps,
    _deps: { evaluate, sleep },
    // A new (forming) bar opens at the end of the series.
    appendBar: () => { st.total++; st.loaded++; },
  };
}

function assertContiguous(bars, step = DAY) {
  for (let i = 1; i < bars.length; i++) assert.equal(bars[i].time - bars[i - 1].time, step, `gap or overlap at ${i}`);
}

describe('getOhlcv() — newest-N reads (backward compatible)', () => {
  it('returns the newest `count` loaded bars, oldest first, without loading history', async () => {
    const tv = fakeChart({ total: 3000, loaded: 300 });
    const res = await getOhlcv({ count: 50, _deps: tv._deps });
    assert.equal(res.success, true);
    assert.equal(res.bar_count, 50);
    assert.equal(res.total_available, 300);
    assert.equal(res.source, 'direct_bars');
    assert.equal(res.bars[49].time, tv.timeAt(2999));
    assert.equal(res.bars[0].time, tv.timeAt(2950));
    assertContiguous(res.bars);
    assert.deepEqual(Object.keys(res), ['success', 'bar_count', 'total_available', 'source', 'bars']);
    assert.equal(tv.st.requests, 0);
    assert.equal(tv.st.availabilityChecks, 0);
    assert.equal(tv.calls.length, 1);
  });

  it('defaults to 100 bars and caps count at 500', async () => {
    const tv = fakeChart({ total: 3000, loaded: 3000 });
    assert.equal((await getOhlcv({ _deps: tv._deps })).bar_count, 100);
    assert.equal((await getOhlcv({ count: 5000, _deps: tv._deps })).bar_count, 500);
  });

  it('returns all loaded bars when fewer than `count` are loaded, and never pages', async () => {
    const tv = fakeChart({ total: 3000, loaded: 120 });
    const res = await getOhlcv({ count: 500, _deps: tv._deps });
    assert.equal(res.bar_count, 120);
    assert.equal(tv.st.requests, 0);
  });

  it('summary mode is unchanged', async () => {
    const tv = fakeChart({ loaded: 300 });
    const res = await getOhlcv({ count: 10, summary: true, _deps: tv._deps });
    assert.equal(res.bar_count, 10);
    assert.equal(res.last_5_bars.length, 5);
    assert.equal(res.oldest_reached, undefined);
  });

  it('fails when the chart has no bar data', async () => {
    const _deps = { evaluate: async () => null, sleep: async () => {} };
    await assert.rejects(getOhlcv({ _deps }), /Could not extract OHLCV data/);
  });
});

describe('getOhlcv() — `before` windows', () => {
  it('reads bars older than the former newest-500 boundary', async () => {
    const tv = fakeChart({ total: 3000, loaded: 3000 });
    const before = tv.timeAt(2500); // oldest bar of the newest 500
    const res = await getOhlcv({ count: 500, before, _deps: tv._deps });
    assert.equal(res.bar_count, 500);
    assert.equal(res.bars[0].time, tv.timeAt(2000));
    assert.equal(res.bars[499].time, tv.timeAt(2499));
    assert.ok(res.bars.every((b) => b.time < before));
    assertContiguous(res.bars);
    assert.equal(res.before, before);
    assert.equal(res.oldest_reached, false);
    assert.equal(res.pages_requested, 0);
  });

  it('`before` is exclusive and need not be a bar time', async () => {
    const tv = fakeChart({ total: 3000, loaded: 3000 });
    const onBar = await getOhlcv({ count: 3, before: tv.timeAt(100), _deps: tv._deps });
    const midBar = await getOhlcv({ count: 3, before: tv.timeAt(99) + 1, _deps: tv._deps });
    assert.deepEqual(onBar.bars.map((b) => b.time), [97, 98, 99].map(tv.timeAt));
    assert.deepEqual(midBar.bars, onBar.bars);
  });

  it('adjacent windows join without gaps or duplicates down to the oldest bar', async () => {
    const tv = fakeChart({ total: 2600, loaded: 300 });
    const first = await getOhlcv({ count: 500, _deps: tv._deps });
    let all = first.bars;
    let res = first;
    let calls = 0;
    do {
      res = await getOhlcv({ count: 500, before: all[0].time, _deps: tv._deps });
      all = res.bars.concat(all);
      calls++;
    } while (!res.oldest_reached && calls < 20);
    assert.equal(res.oldest_reached, true);
    assert.equal(all.length, 2600);
    assert.equal(all[0].time, T0);
    assertContiguous(all);
    assert.equal(new Set(all.map((b) => b.time)).size, all.length);
    const end = await getOhlcv({ count: 500, before: all[0].time, _deps: tv._deps });
    assert.deepEqual({ ...end, total_available: 0 }, {
      success: true, bar_count: 0, total_available: 0, source: 'direct_bars',
      before: T0, oldest_reached: true, pages_requested: 0, bars: [],
    });
  });

  it('a new bar forming between pages does not shift the cursor', async () => {
    const tv = fakeChart({ total: 1000, loaded: 1000 });
    const a = await getOhlcv({ count: 200, _deps: tv._deps });
    tv.appendBar();
    const b = await getOhlcv({ count: 200, before: a.bars[0].time, _deps: tv._deps });
    assertContiguous(b.bars.concat(a.bars));
  });

  it('loads older history when the window reaches the first loaded bar', async () => {
    const tv = fakeChart({ total: 5000, loaded: 300 });
    const before = tv.timeAt(5000 - 300); // first loaded bar: nothing older is loaded yet
    const res = await getOhlcv({ count: 500, before, _deps: tv._deps });
    assert.equal(res.bar_count, 500);
    assert.equal(res.pages_requested, 1);
    assert.equal(tv.st.loaded, 1300);
    assert.equal(res.total_available, 1300);
    assert.deepEqual(tv.sleeps, [1800]);
    assert.ok(tv.calls.some((c) => c.includes('requestMoreData(1000)')));
    assert.equal(res.oldest_reached, false);
  });

  it('reaches a `before` deeper than the loaded series over several pages', async () => {
    const tv = fakeChart({ total: 5000, loaded: 300 });
    const res = await getOhlcv({ count: 100, before: tv.timeAt(2000), _deps: tv._deps });
    assert.equal(res.bars[0].time, tv.timeAt(1900));
    assert.equal(res.bars[99].time, tv.timeAt(1999));
    assert.equal(res.pages_requested, 3); // 300 → 1300 → 2300 → 3300 loaded
  });

  it('returns a short window at the oldest available bar with oldest_reached', async () => {
    const tv = fakeChart({ total: 800, loaded: 300 });
    const res = await getOhlcv({ count: 500, before: tv.timeAt(120), _deps: tv._deps });
    assert.equal(res.bar_count, 120);
    assert.equal(res.bars[0].time, T0);
    assert.equal(res.oldest_reached, true);
    assert.equal(res.pages_requested, 1);
  });

  it('a full window that starts at the oldest bar is oldest_reached', async () => {
    const tv = fakeChart({ total: 500, loaded: 500 });
    const res = await getOhlcv({ count: 100, before: tv.timeAt(100), _deps: tv._deps });
    assert.equal(res.bar_count, 100);
    assert.equal(res.oldest_reached, true);
    assert.equal(res.pages_requested, 0);
  });

  it('no older history: empty successful window, no paging', async () => {
    const tv = fakeChart({ total: 300, loaded: 300 });
    const res = await getOhlcv({ count: 100, before: T0 - 5 * DAY, _deps: tv._deps });
    assert.equal(res.bar_count, 0);
    assert.deepEqual(res.bars, []);
    assert.equal(res.oldest_reached, true);
    assert.equal(res.pages_requested, 0);
    assert.equal(tv.st.requests, 0);
  });

  it('a stalled load stops after one page and never claims the oldest bar', async () => {
    const tv = fakeChart({ total: 3000, loaded: 300, stalled: true });
    const partial = await getOhlcv({ count: 500, before: tv.timeAt(2800), _deps: tv._deps });
    assert.equal(partial.bar_count, 100);
    assert.equal(partial.oldest_reached, false);
    assert.equal(partial.pages_requested, 1);
    await assert.rejects(
      getOhlcv({ count: 500, before: tv.timeAt(2700), _deps: tv._deps }),
      /No loaded bars older than before=.*after 1 history page request\(s\).*retry/,
    );
  });

  it('spends at most 10 history pages per call', async () => {
    const tv = fakeChart({ total: 100000, loaded: 300, step: 60 });
    await assert.rejects(getOhlcv({ count: 500, before: tv.timeAt(1000), _deps: tv._deps }), /after 10 history page/);
    assert.equal(tv.st.requests, 10);
    assert.equal(tv.st.loaded, 10300);
    // A retry continues from the deeper loaded series.
    const res = await getOhlcv({ count: 500, before: tv.timeAt(90000), _deps: tv._deps });
    assert.equal(res.bar_count, 500);
    assertContiguous(res.bars, 60);
  });

  it('without a boolean requestMoreDataAvailable(), never reports oldest_reached', async () => {
    for (const available of ['throw', 1]) {
      const tv = fakeChart({ total: 400, loaded: 300, available });
      const res = await getOhlcv({ count: 500, before: tv.timeAt(200), _deps: tv._deps });
      assert.equal(res.bar_count, 200);
      assert.equal(res.oldest_reached, false);
      assert.equal(res.pages_requested, 2); // second page brings nothing older → stop
    }
  });

  it('summary mode summarizes the window and carries the window fields', async () => {
    const tv = fakeChart({ total: 3000, loaded: 3000 });
    const res = await getOhlcv({ count: 10, before: tv.timeAt(1000), summary: true, _deps: tv._deps });
    assert.equal(res.bar_count, 10);
    assert.deepEqual(res.period, { from: tv.timeAt(990), to: tv.timeAt(999) });
    assert.equal(res.oldest_reached, false);
    assert.equal(res.pages_requested, 0);
  });

  it('rejects invalid parameters before touching the chart', async () => {
    const tv = fakeChart();
    for (const before of [NaN, 'abc', Infinity, 0, -1, 1.7e12]) {
      await assert.rejects(getOhlcv({ before, _deps: tv._deps }), /before must be/, `before=${before}`);
    }
    for (const count of [-5, 2.5]) {
      await assert.rejects(getOhlcv({ count, _deps: tv._deps }), /count must be a positive integer/, `count=${count}`);
    }
    assert.equal(tv.calls.length, 0);
  });
});
