// 流式重绘的节奏（public/js/core/pace.js）：用假的时钟和定时器把每条规矩走一遍
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPacer } from '../public/js/core/pace.js';

/** 假时钟：advance 推进时间并按到点顺序触发定时器；show 每次“花掉” cost 毫秒 */
function rig({ cost = 0, hidden = false, ...opt } = {}) {
    const env = { t: 0, cost, hidden, shows: [], timers: [], latest: '' };
    let seq = 0;
    const setTimer = (fn, ms) => { const id = ++seq; env.timers.push({ id, at: env.t + ms, fn }); return id; };
    const clearTimer = (id) => { env.timers = env.timers.filter(x => x.id !== id); };
    const pacer = createPacer(() => { env.shows.push({ at: env.t, text: env.latest }); env.t += env.cost; },
        { now: () => env.t, hidden: () => env.hidden, setTimer, clearTimer, ...opt });
    env.pacer = pacer;
    env.advance = (ms) => {
        const end = env.t + ms;
        for (;;) {
            const next = env.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0];
            if (!next) break;
            env.timers = env.timers.filter(x => x !== next);
            env.t = Math.max(env.t, next.at);
            next.fn();
        }
        env.t = Math.max(env.t, end);
    };
    /** 来了新内容 */
    env.feed = (text, force = false) => { env.latest = text; pacer.request(force); };
    return env;
}

test('节奏：第一下马上画，之后至少隔 200 毫秒；等的时候来的内容到点补画，画的是最新的', () => {
    const e = rig();
    e.feed('a');
    assert.deepEqual(e.shows, [{ at: 0, text: 'a' }]);
    // 37 毫秒来一块（真实模型大概这个速度）：1 秒里来 27 块
    for (let i = 1; i <= 27; i++) { e.advance(37); e.feed(`块${i}`); }
    e.advance(300);
    const at = e.shows.map(s => s.at);
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 200, `第 ${i} 次离上一次只有 ${at[i] - at[i - 1]} 毫秒`);
    assert.ok(e.shows.length >= 5 && e.shows.length <= 7, `1.3 秒里画了 ${e.shows.length} 次`);
    // 最后来的那一块一定画上去了（不会因为“还在等”就丢掉）
    assert.equal(e.shows.at(-1).text, '块27');
    assert.equal(e.pacer.dirty, false);
    assert.equal(e.timers.length, 0, '没有新内容时不留定时器');
});

test('节奏：画一次越贵歇得越久（rest 倍），封顶 1 秒；便宜的时候回到 200 毫秒', () => {
    const e = rig({ cost: 60 });
    e.feed('a');
    assert.equal(e.pacer.gap, 360);
    for (let i = 0; i < 100; i++) { e.advance(37); e.feed(`x${i}`); }
    const at = e.shows.map(s => s.at);
    // 每次画 60 毫秒、之后歇 360：重画占的时间不超过七分之一多一点
    for (let i = 1; i < at.length; i++) assert.ok(at[i] - (at[i - 1] + 60) >= 360);
    const busy = e.shows.length * 60 / e.t;
    assert.ok(busy < 0.16, `重画占了 ${(busy * 100).toFixed(0)}% 的时间`);
    e.cost = 400;
    e.advance(2000); e.feed('慢');
    assert.equal(e.pacer.gap, 1000, '再贵也不超过 1 秒画一次');
    e.cost = 5;
    e.advance(2000); e.feed('快');
    assert.equal(e.pacer.gap, 200);
});

test('节奏：force 不管节奏马上画；cancel 之后到点的那一下不再画', () => {
    const e = rig();
    e.feed('a');
    e.advance(10); e.feed('b');
    assert.equal(e.shows.length, 1);
    e.feed('c', true);
    assert.deepEqual(e.shows.map(s => s.text), ['a', 'c']);
    assert.equal(e.timers.length, 0, 'force 画过之后原来排着的那一下取消');
    // 生成结束：还在等的那一下作废，之后什么都不会再画（不然会把排好版的楼层画回流式的样子）
    e.advance(10); e.feed('d');
    assert.equal(e.timers.length, 1);
    e.pacer.cancel();
    e.advance(5000);
    assert.deepEqual(e.shows.map(s => s.text), ['a', 'c']);
    e.pacer.flush();
    assert.equal(e.shows.length, 2, 'cancel 之后没有要补画的');
});

test('节奏：页面在后台时不画，回到前台 flush 补上最新的；等的时候切到后台也不画', () => {
    const e = rig({ hidden: true });
    for (let i = 0; i < 50; i++) { e.advance(37); e.feed(`后台${i}`); }
    assert.equal(e.shows.length, 0);
    assert.equal(e.timers.length, 0, '后台不排定时器');
    e.hidden = false;
    e.pacer.flush();
    assert.deepEqual(e.shows.map(s => s.text), ['后台49']);
    e.pacer.flush();
    assert.equal(e.shows.length, 1, '没有新内容时 flush 不重复画');

    // 排好了一下，还没到点页面就切到后台：到点不画，回来再画
    const f = rig();
    f.feed('a');
    f.advance(50); f.feed('b');
    f.hidden = true;
    f.advance(1000);
    assert.deepEqual(f.shows.map(s => s.text), ['a']);
    f.hidden = false;
    f.pacer.flush();
    assert.deepEqual(f.shows.map(s => s.text), ['a', 'b']);
});
