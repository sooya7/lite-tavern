// 轻量 token 估算：不带分词器，按字符类别估算（中文≈1 字 1 token，英文≈3.6 字符 1 token）。
// 只用于预算裁剪与显示，留有余量。

const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/g;

export function estimateTokens(text) {
    if (!text) return 0;
    const s = String(text);
    const cjk = (s.match(CJK_RE) || []).length;
    const rest = s.length - cjk;
    return Math.ceil(cjk * 1.05 + rest / 3.6);
}

export function estimateMessageTokens(msg) {
    if (!msg) return 0;
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    return estimateTokens(content) + 4 + (msg.name ? estimateTokens(msg.name) + 1 : 0);
}

export function estimateMessagesTokens(messages) {
    return (messages || []).reduce((a, m) => a + estimateMessageTokens(m), 3);
}
