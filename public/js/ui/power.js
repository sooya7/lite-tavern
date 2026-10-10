// 省电：卡片（消息里的美化、前端卡界面）常带循环播放的动画——呼吸光晕、闪光条、跳动的小图标。
// 它们只要在放，手机就得一直重画，页面开着不动也会慢慢烫起来。
// 这里只管一件事：判断页面是不是“静止”了（一段时间没有任何操作）。静止时
//   - <body> 带上 lt-idle，消息正文里的动画暂停（css/app.css）；
//   - 通知订阅者（ui/frontend.js 据此让前端卡界面暂停它们的动画）。
// 一碰屏幕、按键、滚轮，或者页面上出了新东西（poke），立刻恢复。
// 只暂停 CSS 动画，不碰卡片的脚本和定时器。设置 › 通用 › 外观与行为 里可以关。
import { state } from '../state.js';

/** 多久没有操作算静止 */
export const IDLE_MS = 20000;

let idle = false, last = 0, timer = 0;
const subs = new Set();

const enabled = () => state.settings?.ui?.pauseIdleAnim !== false;

/** 现在该不该暂停（静止了，而且没在设置里关掉） */
export const isIdle = () => idle && enabled();

/** 静止 / 恢复时叫一声，参数是 isIdle() */
export function onIdleChange(fn) {
    subs.add(fn);
}

/** 把现在的状态落到页面上（状态变了、或者设置里开关了这个功能时） */
export function applyPower() {
    const v = isIdle();
    document.body?.classList.toggle('lt-idle', v);
    for (const fn of subs) fn(v);
}

function set(v) {
    if (idle === v) return;
    idle = v;
    applyPower();
}

function check() {
    timer = 0;
    const rest = IDLE_MS - (performance.now() - last);
    // 这段时间里又动过：等到满 IDLE_MS 再看。静止之后不留任何定时器
    if (rest > 50) timer = setTimeout(check, rest);
    else set(true);
}

/** 有操作，或者页面上有了新内容：算作活动，从头计时 */
export function poke() {
    last = performance.now();
    if (idle) set(false);
    if (!timer) timer = setTimeout(check, IDLE_MS);
}

export function initPower() {
    const opt = { capture: true, passive: true };
    // 不听 scroll：生成时页面自己跟着往下滚也会触发它，那不算有人在操作
    for (const ev of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'keydown', 'wheel']) document.addEventListener(ev, poke, opt);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poke(); });
    poke();
}
