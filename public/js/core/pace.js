// 给“贵的重画”定节奏。流式生成时每来一点字就想重画一次，而重画一次要把整条回复重新排版，
// 回复越长越贵——不加节制的话，长回复能把手机的主线程占满一分多钟，手机就是这么烫起来的。
//
// 规矩：
//   - 两次重画之间至少隔 minMs；
//   - 重画一次花了 t 毫秒，下一次至少等 rest × t（封顶 maxMs）：再长的回复、再慢的设备，重画也只占一小部分时间；
//   - 等的时候来了新内容不丢：到点补画一次，画的是那时最新的；
//   - 页面在后台（hidden）时不画，回到前台由调用方 flush 补上。

/**
 * @param {() => void} show 真正去画（画的是调用方手里最新的内容）
 * @param {{minMs?: number, maxMs?: number, rest?: number, now?: () => number, hidden?: () => boolean,
 *          setTimer?: Function, clearTimer?: Function}} [o] now / setTimer / clearTimer 是给测试换的
 */
export function createPacer(show, { minMs = 200, maxMs = 1000, rest = 6, now = () => performance.now(), hidden = () => false, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let last = -Infinity, gap = minMs, timer = null, dirty = false;
    const run = () => {
        if (timer !== null) clearTimer(timer);
        timer = null;
        dirty = false;
        const t0 = now();
        show();
        last = now();
        gap = Math.min(maxMs, Math.max(minMs, (last - t0) * rest));
    };
    const tick = () => {
        timer = null;
        // 等的这会儿页面切到后台了：先不画，回来 flush
        if (hidden()) return;
        run();
    };
    return {
        /** 有新内容了。force：不管节奏马上画 */
        request(force = false) {
            dirty = true;
            if (force) { run(); return; }
            if (hidden()) return;
            const wait = last + gap - now();
            if (wait <= 0) run();
            else if (timer === null) timer = setTimer(tick, wait);
        },
        /** 还有没画上去的就现在画（页面回到前台时） */
        flush() {
            if (dirty) run();
        },
        /** 到点要画的那一下作废（生成结束了，或者要从头重来） */
        cancel() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            dirty = false;
        },
        /** 现在两次重画之间隔多久（毫秒） */
        get gap() { return gap; },
        /** 有没有还没画上去的内容 */
        get dirty() { return dirty; },
    };
}
