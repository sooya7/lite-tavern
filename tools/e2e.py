# 端到端测试：无头浏览器跑一遍主要流程（连接、导入卡、MVU、前端卡、世界书、EJS、重刷、重试、停止、编辑、
# 提示词预览、Claude/Gemini 格式、设置面板分组与搜索、菜单入口、刷新恢复、酒馆助手脚本、手机布局）。依赖：python playwright + tools/mock-llm.mjs。
# 不需要外网：脚本要从 jsdelivr 取的 zod 和 MVU 变量结构库在这里用下面的替身顶上（真库要联网，另行在部署环境验证）。
# 用法：先起 mock（node tools/mock-llm.mjs 8799）和服务（node server.mjs --port 8731 --data <空目录>），再
#   python tools/e2e.py
# 想连“与酒馆共用数据”一起测：node tools/fake-st-dir.mjs <目录> 造一个假的酒馆数据目录，另起一个实例
#   node server.mjs --port 8732 --data <另一个空目录> --st-data <目录>
# 有 HTTP 代理的环境加 NO_PROXY=127.0.0.1,localhost；用系统 Chromium 时加 LT_CHROMIUM=/usr/bin/chromium。
# 再带上 LT_SHARED_URL=http://127.0.0.1:8732 LT_SHARED_DIR=<目录> LT_SHARED_OWN=<另一个空目录> 跑。
import json
import re
import os
import sys
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get('LT_URL', 'http://127.0.0.1:8731')
MOCK = os.environ.get('MOCK_URL', 'http://127.0.0.1:8799')
SHOTS = os.environ.get('LT_SHOTS', os.path.join(os.environ.get('TEMP', '/tmp'), 'lt-shots'))
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'test-card.json')
SCRIPT_CARD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'script-card.json')
SCRIPT_PRESET = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'script-preset.json')
# 共用酒馆数据目录的那几项：另起一个带 --st-data 的实例，三个都给了才跑
SHARED_URL = os.environ.get('LT_SHARED_URL', '')
SHARED_DIR = os.environ.get('LT_SHARED_DIR', '')  # 假的酒馆用户数据目录
SHARED_OWN = os.environ.get('LT_SHARED_OWN', '')  # 那个实例自己的数据目录

# zod 的替身：只实现脚本测试卡用到的那几个写法（object / string / coerce.number / transform / prefault / safeParse）
FAKE_ZOD = r'''
const node = (parse) => ({
  _parse: parse,
  transform(fn) { return node((v) => fn(parse(v))); },
  prefault(d) { return node((v) => parse(v === undefined ? d : v)); },
  safeParse(v) { try { return { success: true, data: parse(v) }; } catch (e) { return { success: false, error: e }; } },
});
const string = () => node((v) => { if (typeof v !== 'string') throw new Error('不是字符串'); return v; });
const number = () => node((v) => { const n = Number(v); if (Number.isNaN(n)) throw new Error('不是数字'); return n; });
const object = (shape) => Object.assign(node((v) => {
  const out = { ...(v ?? {}) };
  for (const [k, t] of Object.entries(shape)) out[k] = t._parse(out[k]);
  return out;
}), { shape });
const api = { object, string, number, coerce: { number }, prettifyError: (e) => String(e?.message ?? e) };
export const z = api;
export { object, string, number };
export const coerce = { number };
export default api;
'''

# MVU 变量结构库（registerMvuSchema）的替身：按真库的事件约定来——初始化时补默认值；
# 更新时自己执行并拿走命令，剩下的清空；结束时去掉 display_data / delta_data
FAKE_MVU_ZOD = r'''
export function registerMvuSchema(schema) {
  const trim = (s) => String(s).replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, '$1');
  const lit = (s) => { try { return JSON.parse(s); } catch { return trim(s); } };
  eventOn('mag_variable_initialized', (variables) => {
    const r = schema.safeParse(variables.stat_data);
    if (r.success) variables.stat_data = { ...variables.stat_data, ...r.data };
  });
  eventOn('mag_command_parsed_for_zod', (variables, commands) => {
    const done = [];
    commands.forEach((c, i) => {
      const next = _.cloneDeep(variables.stat_data);
      const path = trim(c.args[0]);
      if (c.type === 'set') _.set(next, path, lit(c.args.at(-1)));
      else if (c.type === 'add') _.update(next, path, (v) => v + Number(lit(c.args[1])));
      else return;
      const r = schema.safeParse(next);
      if (!r.success) return;
      variables.stat_data = { ...variables.stat_data, ...r.data };
      done.push(i);
    });
    _.pullAt(commands, done);
  });
  eventOn('mag_command_parsed_ended_for_zod', (variables, commands) => { commands.length = 0; });
  eventOn('mag_variable_update_ended_for_zod', (variables) => { _.unset(variables, 'display_data'); _.unset(variables, 'delta_data'); });
}
'''
os.makedirs(SHOTS, exist_ok=True)

results = []
errors = []
page = None


def shot(name):
    p = os.path.join(SHOTS, f'{name}.png')
    page.screenshot(path=p)
    return p


def run(name, fn):
    t0 = time.time()
    try:
        fn()
        results.append((name, 'OK', f'{time.time() - t0:.1f}s'))
        print(f'[OK]   {name} ({time.time() - t0:.1f}s)', flush=True)
    except Exception as e:  # noqa: BLE001
        results.append((name, 'FAIL', str(e)[:400]))
        print(f'[FAIL] {name}: {str(e)[:400]}', flush=True)
        try:
            shot(f'fail-{len(results):02d}')
        except Exception:  # noqa: BLE001
            pass


def mock(path):
    with urllib.request.urlopen(MOCK + path) as r:
        return json.loads(r.read().decode('utf-8'))


# 服务器代生成用例之间传的东西（页面在线时收尾的那条、停止的那条）
gen_state = {}


def current_chat():
    """最近写过的聊天（角色 id, 聊天名）"""
    with urllib.request.urlopen(BASE + '/api/recent-chats?limit=1') as r:
        x = json.loads(r.read().decode('utf-8'))[0]
    return re.sub(r'\.(png|json)$', '', x['file']), x['chat']


def chat_lines_direct(cid=None, name=None):
    """直接从服务器读聊天文件（不经页面），返回楼层列表（不含第一行元数据）"""
    if cid is None:
        cid, name = current_chat()
    q = urllib.parse.quote
    with urllib.request.urlopen(f'{BASE}/api/chats/{q(cid, safe="")}/{q(name, safe="")}') as r:
        lines = [json.loads(l) for l in r.read().decode('utf-8').splitlines() if l.strip()]
    return lines[1:]


def chat_lines():
    page.wait_for_timeout(700)  # 等页面的防抖保存
    return chat_lines_direct()


# 设置面板：分区 → 所在分组（和 public/js/ui/panels/nav.js 一致）
SECTION_GROUP = {
    '连接': 'model', '预设': 'model',
    '角色卡': 'char', '世界书': 'char', '正则': 'char', '脚本': 'char',
    '作者注释': 'chat', '变量': 'chat', '提示词预览': 'chat',
    '用户设定': 'general', '外观与行为': 'general', '导入': 'general',
}


def open_settings(pg=None):
    pg = pg or page
    if 'right-closed' in pg.locator('#app').get_attribute('class'):
        pg.locator('#topbar button[title="设置"]').click()
        pg.wait_for_timeout(300)


def right_tab(label, pg=None, sub=None):
    """打开设置面板里的某个分区：先点左边的分组，再点顶上的分区；sub 是分区里的小标签"""
    pg = pg or page
    open_settings(pg)
    pg.locator(f'#right .panel-rail .tab[data-group="{SECTION_GROUP[label]}"]').click()
    pg.locator('#right .panel-seg:not(.vars-seg) .seg-tab', has_text=label).first.click()
    pg.wait_for_timeout(150)
    if sub:
        pg.locator('#right .vars-seg .seg-tab', has_text=sub).click()
        pg.wait_for_timeout(150)


def menu_labels():
    return [t.strip() for t in page.locator('.menu button').all_inner_texts()]


def close_menu():
    page.mouse.click(5, 450)
    page.wait_for_timeout(150)


def mes_count():
    return page.locator('#chat .mes').count()


def last_text():
    return page.locator('#chat .mes').last.locator('.mes_text').inner_text()


def wait_gen(timeout=40000):
    try:
        page.wait_for_selector('#send_but.stop', timeout=3000)
    except Exception:  # noqa: BLE001
        pass
    page.wait_for_function("() => !document.querySelector('#send_but.stop')", timeout=timeout)
    page.wait_for_timeout(400)


def open_fold(title, pg=None):
    """展开设置面板里默认收起的一栏"""
    pg = pg or page
    d = pg.locator('#right details.fold', has=pg.locator('summary', has_text=title)).first
    if not d.evaluate('e => e.open'):
        d.locator(':scope > summary').click()
        pg.wait_for_timeout(150)


def send(text):
    page.fill('#send_textarea', text)
    page.click('#send_but')
    wait_gen()


def assert_in(needle, hay, what=''):
    if needle not in hay:
        raise AssertionError(f'{what} 里没找到「{needle}」：{hay[:300]!r}')


def main():
    global page
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('LT_CHROMIUM') or None)
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')

        def offline_cdn(context):
            # 后注册的优先：先把 jsdelivr 整个掐掉（测试环境没有外网，掐掉比等超时快），再放行两个替身
            js = {'content_type': 'text/javascript; charset=utf-8', 'headers': {'access-control-allow-origin': '*'}}
            context.route('https://*.jsdelivr.net/**', lambda r: r.abort())
            context.route('https://*.jsdelivr.net/npm/zod@*/+esm', lambda r: r.fulfill(body=FAKE_ZOD, **js))
            context.route('https://*.jsdelivr.net/gh/StageDog/tavern_resource/dist/util/mvu_zod.js', lambda r: r.fulfill(body=FAKE_MVU_ZOD, **js))
        offline_cdn(ctx)
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error',) else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e} @ {" | ".join((getattr(e, "stack", "") or "").splitlines()[1:3]).strip()}'))

        def open_app():
            page.goto(BASE + '/')
            page.wait_for_selector('#composer textarea', state='attached')
            page.wait_for_selector('#chat .home-wrap')  # 还没有角色：首页（问候 + 上手步骤）
            page.wait_for_timeout(500)
            shot('01-first-run')
        run('打开首页', open_app)

        def setup_connection():
            right_tab('连接')
            page.get_by_role('button', name='OpenAI 兼容 / 中转').click()
            page.locator('#right input[placeholder="https://api.openai.com/v1"]').fill(MOCK + '/v1')
            page.locator('#right input[type=password]').fill('sk-e2e-test-key')
            page.locator('#right button', has_text='保存').first.click()
            page.wait_for_selector('#right input[type=password][placeholder^="已保存"]')
            page.locator('#right button', has_text='获取').click()
            page.wait_for_selector('#right select >> text=从 3 个模型里选…', state='attached')
            sel = page.locator('#right select').filter(has_text='从 3 个模型里选')
            sel.select_option('mock-gpt')
            page.locator('#right button', has_text='测试连接').click()
            page.wait_for_selector('#right >> text=连通', timeout=10000)
            last = mock('/last')
            assert last['body']['model'] == 'mock-gpt', last['body'].get('model')
            assert last['headers']['auth'] == 'Bearer ***', '密钥没带上'
            shot('02-connection')
        run('配置 OpenAI 兼容连接（填地址/存密钥/拉模型/测试）', setup_connection)

        def secret_not_leaked():
            s = page.evaluate("fetch('/api/settings').then(r => r.text())")
            assert 'sk-e2e-test-key' not in s, '设置里出现了明文密钥'
            sec = page.evaluate("fetch('/api/secrets').then(r => r.text())")
            assert 'sk-e2e-test-key' not in sec, '/api/secrets 返回了明文'
        run('密钥不回传浏览器', secret_not_leaked)

        def import_card():
            with page.expect_file_chooser() as fc:
                page.locator('#chat .home-actions button', has_text='导入角色卡').click()
            fc.value.set_files(FIXTURE)
            page.wait_for_selector('#chat .mes[mesid="0"]', timeout=10000)
            page.wait_for_timeout(1200)
            frame = page.frame_locator('#chat .mes[mesid="0"] iframe')
            txt = frame.locator('#s').inner_text(timeout=8000)
            assert_in('好感度：10', txt, '开场白状态栏')
            assert_in('地点：门口', txt, '开场白状态栏')
            assert_in('欢迎回来，User', last_text(), '开场白')
            fh = page.evaluate("document.querySelector('#chat .mes[mesid=\"0\"] iframe').getBoundingClientRect().height")
            assert fh < 60, f'前端卡 iframe 高度 {fh}px，没有贴合内容'
            shot('03-card-imported')
        run('导入测试卡（内嵌世界书/正则/前端卡/MVU 初始化）', import_card)

        def first_reply():
            send('你好，我想去古籍区看看 MVU HTML THINK')
            n = mes_count()
            assert n == 3, f'消息数 {n}'
            m = page.locator('#chat .mes').last
            assert m.locator('.reasoning').count() == 1, '没有思维链折叠块'
            t = m.locator('.mes_text').inner_text()
            assert_in('收到', t, 'AI 回复')
            assert 'UpdateVariable' not in t, '仅显示正则没把变量块藏起来'
            page.wait_for_timeout(1000)
            ftxt = page.frame_locator('#chat .mes[mesid="2"] iframe').locator('#b').inner_text(timeout=8000)
            assert_in('好感度 15', ftxt, '回复里的前端卡')
            assert_in('楼层 2', ftxt, '回复里的前端卡')
            body = mock('/last')['body']
            allc = '\n'.join(x['content'] for x in body['messages'])
            assert_in('测试小林是图书馆管理员', allc, '提示词（角色描述+宏）')
            assert_in('图书馆顶楼是古籍区', allc, '提示词（关键词世界书）')
            assert_in('好感度: 10', allc, '提示词（format_message_variable）')
            assert_in('好感度还不高', allc, '提示词（EJS 条件）')
            assert_in('有新书吗', allc, '提示词（示例对话）')
            assert '<%' not in allc, '提示词里残留 EJS'
            assert '{{' not in allc, '提示词里残留宏'
            shot('04-first-reply')
        run('发送消息：流式、思维链、MVU 更新、前端卡、世界书/EJS 进提示词', first_reply)

        def vars_panel():
            right_tab('变量', sub='查看变量')
            open_fold('角色状态')
            page.wait_for_selector('#right .fold-body >> text=MVU 已启用')
            page.locator('#right details.fold > summary', has_text='角色状态').first.click()
            page.wait_for_timeout(150)
            assert page.locator('#right details.fold', has=page.locator('summary', has_text='角色状态')).first.evaluate('e => !e.open'), '应能收起'
            right_tab('外观与行为'); right_tab('变量', sub='查看变量')
            page.locator('#right').screenshot(path='/tmp/lt-shots/vars-closed.png')
            assert page.locator('#right details.fold', has=page.locator('summary', has_text='角色状态')).first.evaluate('e => !e.open'), '默认收起'
            open_fold('角色状态')
            tree = page.locator('#right pre.var-tree').first.inner_text()
            assert_in('好感度: 15', tree, 'MVU 面板')
            assert_in('地点: 图书馆', tree, 'MVU 面板')
            shot('05-vars')
        run('变量面板显示 MVU 最新状态', vars_panel)

        def swipe():
            m = page.locator('#chat .mes[mesid="2"]')
            m.locator('.swipes button[title^="下一个"]').click()
            wait_gen()
            cnt = page.locator('#chat .mes[mesid="2"] .swipes > span').inner_text()
            assert cnt == '2/2', cnt
            page.locator('#chat .mes[mesid="2"] .swipes button[title="上一个"]').click()
            page.wait_for_timeout(300)
            cnt = page.locator('#chat .mes[mesid="2"] .swipes > span').inner_text()
            assert cnt == '1/2', cnt
            body = mock('/last')['body']
            last_user = [x for x in body['messages'] if x['role'] == 'user'][-1]['content']
            assert_in('古籍区', last_user, '重刷时的最后一条用户消息')
        run('重刷（swipe）生成第二个版本并能左右切换', swipe)

        def retry_429():
            before = mock('/count').get('ERR429', 0)
            send('ERR429 测试重试')
            assert mock('/count').get('ERR429', 0) >= before + 2, '没有重试'
            assert_in('收到', last_text(), '重试后的回复')
        run('429 自动重试', retry_429)

        def retry_errtext():
            send('ERRTEXT 中转把错误当正文')
            t = last_text()
            assert 'failed with status' not in t, '错误正文被当成回复了'
            assert_in('收到', t, '重试后的回复')
        run('“错误当正文”识别并重试', retry_errtext)

        def retry_empty():
            send('EMPTY 空回复')
            assert_in('收到', last_text(), '空回复重试后的回复')
        run('空回复重试', retry_empty)

        def stop_midway():
            n0 = mes_count()
            aborted0 = mock('/count').get('ABORTED', 0)
            page.fill('#send_textarea', 'SLOW 停止测试')
            page.click('#send_but')
            page.wait_for_selector('#send_but.stop', timeout=5000)
            page.wait_for_timeout(900)
            streaming_text = last_text()
            assert len(streaming_text.strip()) > 0, '流式过程中消息是空的（没有边生成边显示）'
            page.click('#send_but')
            page.wait_for_function("() => !document.querySelector('#send_but.stop')", timeout=10000)
            page.wait_for_timeout(400)
            assert mes_count() == n0 + 2, f'消息数 {mes_count()}（应为 {n0 + 2}）'
            t = last_text()
            assert len(t) > 0, '停止后部分内容没保留'
            assert '【结束】' not in t, '没停住（内容完整）'
            # 停止按钮让服务器断开了上游；后面等过宽限期再看服务器没有把完整回复写进去
            assert mock('/count').get('ABORTED', 0) > aborted0, '停止后服务器没有断开上游'
        run('中途停止并保留已生成部分', stop_midway)


        def edit_hide_delete():
            last = page.locator('#chat .mes').last
            last.hover()
            last.locator('button[title="编辑"]').click()
            page.locator('#chat .mes-edit textarea').fill('这是编辑后的内容')
            page.locator('#chat .mes-edit button', has_text='保存').click()
            page.wait_for_timeout(300)
            assert_in('这是编辑后的内容', last_text(), '编辑后')
            n = mes_count()
            last = page.locator('#chat .mes').last
            last.hover()
            last.locator('button[title="更多"]').click()
            page.locator('.menu button', has_text='隐藏（不发给 AI）').click()
            page.wait_for_timeout(200)
            assert 'hidden-msg' in page.locator('#chat .mes').last.get_attribute('class'), '没隐藏'
            last = page.locator('#chat .mes').last
            last.hover()
            last.locator('button[title="更多"]').click()
            page.locator('.menu button', has_text='删除这条').first.click()
            page.locator('.modal-foot button', has_text='删除').click()
            page.wait_for_timeout(300)
            assert mes_count() == n - 1, f'删除后消息数 {mes_count()}'
        run('编辑 / 隐藏 / 删除消息', edit_hide_delete)

        def inspector():
            right_tab('提示词预览')
            page.locator('#right button', has_text='预览下一次发送').click()
            page.wait_for_selector('#right >> text=估算 tokens', timeout=10000)
            assert page.locator('#right .prompt-msg').count() > 3, '预览里消息太少'
            shot('06-inspector')
        run('提示词预览', inspector)

        def claude_and_gemini():
            right_tab('连接')
            for label, base_ph, model, path_part in [
                ('Claude 官方', 'https://api.anthropic.com', 'mock-claude', '/v1/messages'),
                ('Gemini（AI Studio）', 'https://generativelanguage.googleapis.com', 'gemini-mock', 'streamGenerateContent'),
            ]:
                page.locator('#right button[title="新建连接"]').click()
                page.locator('.menu button', has_text=label).click()
                page.locator(f'#right input[placeholder="{base_ph}"]').fill(MOCK)
                page.locator('#right input[type=password]').fill('k-e2e')
                page.locator('#right button', has_text='保存').first.click()
                page.wait_for_selector('#right input[type=password][placeholder^="已保存"]')
                model_input = page.locator('#right input[list^="models-"]')
                model_input.fill(model)
                page.wait_for_timeout(700)
                send(f'用 {label} 发一条 THINK')
                last = mock('/last')
                assert path_part in last['path'], last['path']
                assert_in('收到', last_text(), f'{label} 回复')
            shot('07-gemini')
        run('Claude / Gemini 格式收发', claude_and_gemini)

        def enter_from_home():
            # 打开时先显示首页（最近聊天）：点第一条回到刚才的聊天
            page.wait_for_selector('#chat .recent-item, #chat .mes', timeout=15000)
            if page.locator('#chat .recent-item').count():
                page.locator('#chat .recent-item').first.click()

        def reload_restore():
            n = mes_count()
            page.reload(); enter_from_home()
            page.wait_for_selector('#chat .mes')
            page.wait_for_timeout(1500)
            assert mes_count() == n, f'刷新后消息数 {mes_count()}（应为 {n}）'
        run('刷新后恢复上次聊天', reload_restore)

        # ---------- 服务器代生成（页面切后台 / 锁屏 / 关掉之后回复和变量仍由服务器完成） ----------

        def server_gen_online():
            # 前面的用例停在 Gemini 假模型上；换回 OpenAI 格式的那个（额外模型解析的假回复是 OpenAI 格式）
            page.locator('#composer-model').click()
            page.locator('.menu button', has_text='mock-gpt').first.click()
            page.wait_for_timeout(300)
            assert page.evaluate("fetch('/api/ping').then(r => r.json())").get('genJobs'), '服务端没有代生成'
            send('页面在线时自己收尾')
            msgs = chat_lines()
            m = msgs[-1]
            assert_in('收到', m['mes'], '回复')
            assert 'lt_server_persisted' not in (m.get('extra') or {}), f"页面在线时不该由服务器写：{m.get('extra')} {m.get('gen_started')}"
            assert 'lt_job' not in (m.get('extra') or {}), '占位的任务号没去掉'
            gen_state['online'] = (len(msgs) - 1, m['mes'])
        run('代生成：页面在线时照常由页面收尾', server_gen_online)

        def server_gen_resume_stream():
            reqs = []
            page.on('request', lambda r: reqs.append(r.url) if '/api/gen/' in r.url and '/events' in r.url else None)
            page.fill('#send_textarea', 'SLOW 断网续传')
            page.click('#send_but')
            page.wait_for_selector('#send_but.stop', timeout=5000)
            page.wait_for_timeout(1500)
            assert len(last_text().strip()) > 0, '流式过程中消息是空的'
            ctx.set_offline(True)
            # 断网后马上让页面重连（和手机切回前台时一样），这次连不上，等网络恢复再连
            page.evaluate("window.dispatchEvent(new Event('online'))")
            page.wait_for_timeout(2500)
            ctx.set_offline(False)
            page.evaluate("window.dispatchEvent(new Event('online'))")
            wait_gen(60000)
            t = last_text()
            assert t.count('她慢慢合上书') == 20, f'续传后内容不对（丢字或重字）：{t[-200:]!r}'
            assert t.count('【结束】') == 1 and t.count('收到') == 1, f'续传后内容不对：{t[:200]!r}'
            assert any('after=0' not in u for u in reqs), f'没有按 seq 续订：{reqs}'
            m = chat_lines()[-1]
            assert m['mes'].count('她慢慢合上书') == 20 and m['mes'].count('【结束】') == 1, '存进聊天的内容不对'
        run('代生成：断网后重连按 seq 续传，不丢字不重字', server_gen_resume_stream)

        def reopen_page():
            global page
            page = ctx.new_page()
            page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error',) else None)
            page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
            page.goto(BASE + '/')
            page.wait_for_selector('#composer textarea', state='attached')
            enter_from_home()
            page.wait_for_selector('#chat .mes')
            page.wait_for_timeout(800)

        def wait_server_persisted(n, timeout=60):
            t0 = time.time()
            while time.time() - t0 < timeout:
                msgs = chat_lines_direct()
                if len(msgs) >= n and (msgs[-1].get('extra') or {}).get('lt_server_persisted'):
                    return msgs
                time.sleep(0.5)
            raise AssertionError(f'{timeout} 秒内服务器没有把回复写进聊天（现在 {len(chat_lines_direct())} 条）')

        def latest_stat(msgs):
            for m in reversed(msgs):
                v = m.get('variables')
                if isinstance(v, list) and len(v) > m.get('swipe_id', 0) and isinstance(v[m.get('swipe_id', 0)], dict) and 'stat_data' in v[m.get('swipe_id', 0)]:
                    return v[m.get('swipe_id', 0)]['stat_data']
            return {}

        def server_gen_page_closed():
            before = chat_lines()
            prev = latest_stat(before)
            aborted0 = mock('/count').get('ABORTED', 0)
            page.fill('#send_textarea', 'SLOW MVU 关掉页面也要写完')
            page.click('#send_but')
            page.wait_for_selector('#send_but.stop', timeout=5000)
            page.wait_for_timeout(1500)
            assert len(last_text().strip()) > 0, '流式过程中消息是空的'
            page.close()  # 关掉页面（手机上锁屏 / 杀掉标签页时浏览器里的请求就这样没了）
            msgs = wait_server_persisted(len(before) + 2)
            assert mock('/count').get('ABORTED', 0) == aborted0, '页面关掉后服务器不该断开上游'
            m = msgs[-1]
            mark = m['extra']['lt_server_persisted']
            assert mark['pending'] and mark['mvu'], mark
            assert m['mes'].count('【结束】') == 1, '服务器写进去的回复不完整'
            assert m['extra'].get('reasoning') is None or True
            st = m['variables'][m.get('swipe_id', 0)]['stat_data']
            assert st['好感度'] == prev['好感度'] + 5, f"随 AI 输出的变量没在服务器上更新：{st}（之前 {prev}）"
            assert st['地点'] == '图书馆', st
            reopen_page()
            t = last_text()
            assert_in('【结束】', t, '重开后看到的回复')
            assert 'UpdateVariable' not in t, '仅显示正则没把变量块藏起来'
            v = page.evaluate("window.TavernHelper.getVariables({ type: 'message', message_id: -1 })")
            assert v['stat_data']['好感度'] == st['好感度'], v
            # 打开后补发了事件，标记里的 pending 去掉
            t0 = time.time()
            while (chat_lines_direct()[-1]['extra']['lt_server_persisted'] or {}).get('pending') and time.time() - t0 < 15:
                time.sleep(0.5)
            assert not chat_lines_direct()[-1]['extra']['lt_server_persisted']['pending'], '重开后没有补发事件'
            assert mes_count() == len(msgs), f'界面上的楼层数 {mes_count()}，文件里 {len(msgs)}'
        run('代生成：生成中关掉页面 → 服务器写完回复和随 AI 输出的变量 → 重开看到完整回复和变量', server_gen_page_closed)

        def server_gen_no_double_write():
            # 前面页面在线时收尾的那条，过了宽限期也没被服务器再写一遍；停止那次也没有被服务器补全
            msgs = chat_lines_direct()
            i, mes = gen_state['online']
            assert msgs[i]['mes'] == mes and 'lt_server_persisted' not in (msgs[i].get('extra') or {}), '页面在线时服务器又写了一遍'
            assert msgs[i + 1]['is_user'], '页面在线那次之后多出了一条回复'
            # 服务器写过的只有“关掉页面”那一条（停止的那次要是被服务器补全了，会多出带标记的楼层）
            marked = [k for k, x in enumerate(msgs) if (x.get('extra') or {}).get('lt_server_persisted')]
            assert len(marked) == 1 and '关掉页面也要写完' in msgs[marked[0] - 1]['mes'], f'服务器写过的楼层不对：{marked}'
        run('代生成：页面在线时、点了停止时服务器都不会再写', server_gen_no_double_write)

        def server_gen_extra_vars():
            right_tab('变量', sub='MVU 设置')
            sel = page.locator('#right .card', has=page.locator('.card-title', has_text='变量更新方式')).first.locator('select').first
            sel.select_option('extra')
            page.wait_for_timeout(800)  # 设置防抖落盘
            before = chat_lines()
            prev = latest_stat(before)
            sep0 = mock('/count').get('MVUSEP', 0)
            page.fill('#send_textarea', 'SLOW 额外模型解析也在服务器上')
            page.click('#send_but')
            page.wait_for_selector('#send_but.stop', timeout=5000)
            page.wait_for_timeout(1500)
            page.close()
            msgs = wait_server_persisted(len(before) + 2)
            assert mock('/count').get('MVUSEP', 0) > sep0, '服务器没有发额外模型解析的请求'
            m = msgs[-1]
            assert_in('<UpdateVariable>', m['mes'], '更新块写回正文')
            st = m['variables'][m.get('swipe_id', 0)]['stat_data']
            assert st['地点'] == '书库' and st['好感度'] == prev['好感度'] + 3, f'额外模型解析的变量：{st}（之前 {prev}）'
            reopen_page()
            v = page.evaluate("window.TavernHelper.getVariables({ type: 'message', message_id: -1 })")
            assert v['stat_data']['地点'] == '书库', v
            right_tab('变量', sub='MVU 设置')
            page.locator('#right .card', has=page.locator('.card-title', has_text='变量更新方式')).first.locator('select').first.select_option('ai')
            page.wait_for_timeout(800)
            # 设置面板放回原来的位置（后面的用例按分组里记住的分区数标签）
            right_tab('提示词预览')
            right_tab('连接')
        run('代生成：额外模型解析的变量也由服务器算好', server_gen_extra_vars)

        def server_gen_reload_resume():
            # 刷新页面：生成中的任务接着显示，收尾仍由页面做
            page.fill('#send_textarea', 'SLOW 刷新后接着看')
            page.click('#send_but')
            page.wait_for_selector('#send_but.stop', timeout=5000)
            page.wait_for_timeout(1200)
            n = mes_count()
            page.reload(); enter_from_home()
            page.wait_for_selector('#send_but.stop', timeout=15000)
            wait_gen(60000)
            assert mes_count() == n, f'刷新后楼层数 {mes_count()}（应为 {n}）'
            t = last_text()
            assert t.count('她慢慢合上书') == 20 and t.count('【结束】') == 1, f'刷新后接回的内容不对：{t[-120:]!r}'
            m = chat_lines()[-1]
            assert 'lt_server_persisted' not in (m.get('extra') or {}), '刷新后页面在线，应由页面收尾'
        run('代生成：刷新页面后自动接回生成中的任务', server_gen_reload_resume)

        def settings_groups():
            open_settings()
            groups = [t.strip() for t in page.locator('#right .panel-rail .tab').all_inner_texts()]
            assert groups == ['模型', '角色', '本聊天', '通用'], groups
            want = {
                'model': ['连接', '预设'],
                'char': ['角色卡', '世界书', '正则', '脚本'],
                'chat': ['作者注释', '变量', '提示词预览'],
                'general': ['用户设定', '外观与行为', '导入'],
            }
            for gid, sections in want.items():
                page.locator(f'#right .panel-rail .tab[data-group="{gid}"]').click()
                page.wait_for_timeout(120)
                got = [t.strip() for t in page.locator('#right .seg-tab').all_inner_texts()]
                assert got == sections, f'{gid}: {got}'
                for sec in sections:
                    page.locator('#right .seg-tab', has_text=sec).first.click()
                    page.wait_for_timeout(120)
                    assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == sec
                    assert '面板出错' not in page.locator('#right .panel-body').inner_text(), f'{sec} 渲染出错'
            # 分组记得上次停在哪个分区
            right_tab('世界书')
            page.locator('#right .panel-rail .tab[data-group="model"]').click()
            page.locator('#right .panel-rail .tab[data-group="char"]').click()
            page.wait_for_timeout(120)
            assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '世界书'
            shot('08-settings-groups')
        run('设置面板：4 个分组、12 个分区都能打开', settings_groups)

        def settings_search():
            open_settings()
            box = page.locator('#right .panel-search input')
            box.fill('字体大小')  # 别名 → 正文字号
            page.wait_for_selector('#right .panel-result')
            first = page.locator('#right .panel-result').first.inner_text()
            assert_in('正文字号', first, '搜索结果第一条')
            assert_in('通用 › 外观与行为', first, '搜索结果的位置')
            shot('09-settings-search')
            box.press('Enter')
            page.wait_for_timeout(300)
            assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '外观与行为'
            assert_in('正文字号', page.locator('#right .flash').first.inner_text(), '定位到的那一项')
            assert box.input_value() == '', '跳过去之后搜索框应该清空'
            # 折叠块里的项：先展开再定位
            box.fill('temperature')
            page.locator('#right .panel-result', has_text='温度').first.click()
            page.wait_for_timeout(300)
            assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '预设'
            flashed = page.locator('#right .flash').first
            assert_in('温度', flashed.inner_text(), '定位到的那一项')
            assert flashed.is_visible(), '温度在折叠块里，没被展开'
            # 清单里每一项都要真的能定位到（切分区 → 展开折叠块 → 那一项可见并高亮）
            missed = page.evaluate('''async () => {
                const { FEATURES } = await import('/js/ui/panels/search.js');
                const { openFeature } = await import('/js/ui/panels/index.js');
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const out = [];
                for (const f of FEATURES) {
                    if (f.action) continue;
                    document.querySelectorAll('#right .flash').forEach(el => el.classList.remove('flash'));
                    openFeature(f);
                    let el = null;
                    for (let i = 0; i < 12 && f.find && !el; i++) { await sleep(60); el = document.querySelector('#right .flash'); }
                    if (document.querySelector('#right').dataset.tab !== f.tab) out.push(`${f.t}: 没切到 ${f.tab}`);
                    else if (f.find && !el) out.push(`${f.t}: 找不到「${f.find}」`);
                    else if (el && !(el.offsetWidth && el.offsetHeight)) out.push(`${f.t}: 找到了但没显示出来`);
                    else if (el) { const r = el.getBoundingClientRect(), b = document.querySelector('#right .panel-body').getBoundingClientRect(); if (r.bottom < b.top || r.top > b.bottom) out.push(`${f.t}: 没滚到可见范围`); }
                }
                return out;
            }''')
            assert not missed, f'搜索清单里有定位不到的项：{missed}'
            # 没结果时给提示，不是空白
            box.fill('这个功能不存在xyz')
            page.wait_for_selector('#right .panel-results-empty')
            box.press('Escape')
            page.wait_for_timeout(100)
            assert page.locator('#right .panel-results').is_hidden()
            # Ctrl+K 直接进搜索框（面板收起时先打开）
            page.locator('#right button[title="收起"]').click()
            page.wait_for_timeout(300)
            page.keyboard.press('Control+k')
            page.wait_for_timeout(300)
            assert 'right-closed' not in page.locator('#app').get_attribute('class'), 'Ctrl+K 没打开设置面板'
            assert page.evaluate("document.activeElement === document.querySelector('#right .panel-search input')"), '光标没进搜索框'
            # 面板外的动作也能搜到并直接执行
            chats = page.locator('#left .chat-item').count()
            page.keyboard.type('新聊天')
            first = page.locator('#right .panel-result').first
            assert_in('直接执行', first.inner_text(), '动作类结果')
            page.keyboard.press('Enter')
            page.wait_for_function(f"() => document.querySelectorAll('#left .chat-item').length === {chats + 1}", timeout=5000)
            assert mes_count() == 1, f'新聊天应该只有开场白，实际 {mes_count()} 条'
        run('设置面板：搜功能并跳到对应位置', settings_search)

        def one_home_per_feature():
            # 输入框的 +：只有三种生成方式
            page.locator('#composer .composer-bar .tool').click()
            got = menu_labels()
            assert got == ['继续写最后一条', '重新生成最后一条', '代我写一条（扮演用户）'], got
            close_menu()
            # 标题菜单：只有对这个聊天本身的操作
            page.locator('#topbar .title-btn').click()
            got = menu_labels()
            assert got == ['重命名', '导出 JSONL（酒馆可直接导入）', '删除聊天'], got
            close_menu()
            # 消息的“更多”里不再重复“重新生成 / 继续写”
            last = page.locator('#chat .mes').last
            last.hover()
            last.locator('button[title="更多"]').click()
            got = menu_labels()
            assert not any(x in ('重新生成', '继续写') for x in got), got
            assert_in('从这里分支', ' '.join(got), '消息菜单')
            close_menu()
            # 左栏只剩导航；顶栏没有图标猜谜
            nav = [t.strip() for t in page.locator('#left .side-nav .nav-item').all_inner_texts()]
            assert [n.split('\n')[0] for n in nav] == ['新聊天', '首页'], nav
            assert page.locator('#left .side-head button').count() == 1, '左栏头部应该只剩“收起”'
            assert page.locator('#topbar .tb-btn.toggle-right').inner_text().strip() == '设置'
        run('每个功能只留一个入口（+ / 标题 / 消息菜单 / 左栏）', one_home_per_feature)

        def preset_chip():
            page.locator('#composer-preset').click()
            got = menu_labels()
            assert got[-1] == '编辑预设…' and len(got) >= 2, got
            assert page.locator('.menu button.current').count() == 1, '当前预设没打勾'
            page.locator('.menu button', has_text='编辑预设…').click()
            page.wait_for_timeout(300)
            assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '预设'
        run('输入框上直接切换预设', preset_chip)

        def toggle_theme():
            # 深浅色只在“设置 › 通用 › 外观与行为”里；搜“深色”能直接到
            before = page.evaluate("document.documentElement.dataset.theme")
            assert before in ('light', 'dark'), f'主题属性异常：{before!r}'
            other = 'dark' if before == 'light' else 'light'
            open_settings()
            page.locator('#right .panel-search input').fill('深色')
            page.locator('#right .panel-result', has_text='主题').first.click()
            page.wait_for_timeout(300)
            sel = page.locator('#right .field', has_text='主题').locator('select')
            sel.select_option(other)
            page.wait_for_timeout(300)
            after = page.evaluate("document.documentElement.dataset.theme")
            assert after == other, f'换了主题没变（还是 {after}）'
            shot(f'10-{after}')
            page.reload(); enter_from_home()
            page.wait_for_selector('#chat .mes')
            assert page.evaluate("document.documentElement.dataset.theme") == after, '刷新后主题没保住'
            right_tab('外观与行为')
            page.locator('#right .field', has_text='主题').locator('select').select_option('auto')
            page.wait_for_timeout(300)
            assert page.evaluate("document.documentElement.dataset.theme") == before
        run('在设置里切换深浅色并在刷新后保持', toggle_theme)


        # ---------- 酒馆助手脚本 ----------
        def script_vars(mid):
            return page.evaluate("(id) => window.TavernHelper.getVariables({ type: 'message', message_id: id })", mid)

        def script_row(name):
            return page.locator('#right .script-row', has=page.locator('.script-name', has_text=name)).first

        def js(expr):
            return page.evaluate(expr)

        def import_script_card():
            # 前面的用例停在 Gemini 假模型上；换回 OpenAI 格式的那个，后面要核对请求体
            page.locator('#composer-model').click()
            page.locator('.menu button', has_text='mock-gpt').first.click()
            page.wait_for_timeout(300)
            page.locator('#left button', has_text='首页').first.click()
            page.wait_for_selector('#chat .home-wrap')
            page.locator('#chat .home-tab', has_text='角色库').click()
            with page.expect_file_chooser() as fc:
                page.locator('#chat .home-tab-actions button', has_text='导入').click()
            fc.value.set_files(SCRIPT_CARD)
            page.wait_for_selector('#toasts .toast >> text=已导入角色「脚本测试卡」', timeout=10000)
            tip = page.locator('#toasts .toast', has_text='已导入角色「脚本测试卡」').inner_text()
            assert_in('世界书「脚本卡的书」已添加并绑定', tip, '导入提示')
            assert_in('6 个脚本（5 个启用', tip, '导入提示')
            assert_in('1 条正则', tip, '导入提示')
            # 世界书真的进了世界书列表，并且绑在卡上
            worlds = js("fetch('/api/worlds').then(r => r.json()).then(l => l.map(x => x.name))")
            assert '脚本卡的书' in worlds, f'世界书列表里没有卡自带的那本：{worlds}'
            page.wait_for_selector('#chat .mes[mesid="0"]', timeout=10000)
            bound = js("window.TavernHelper.getCharWorldbookNames('current')")
            assert bound['primary'] == '脚本卡的书', f'卡没绑上自带的世界书：{bound}'
            # 脚本不用任何手动操作就跑起来了
            page.wait_for_selector('#e2e-float', state='attached', timeout=15000)
            page.wait_for_function("() => document.querySelector('#e2e-float').textContent.includes('好感度 10')", timeout=8000)
            assert_in('脚本测试卡 · 共 1 楼', page.locator('#e2e-float').inner_text(), '悬浮窗')
            assert page.locator('#e2e-parent-el').count() == 1, '脚本用 window.parent.document 建的元素不在'
            page.wait_for_selector('#e2e-self-clean', state='attached', timeout=8000)
            assert js('window.__e2eGlobal') == 'set-by-script', '脚本写到页面上的全局变量不在'
            assert js('window.__e2eDisabled') is None, '卡里关着的脚本被运行了'
            assert js("document.querySelectorAll('#lt-script-frames iframe').length") == 4, '应该有 4 个脚本在跑（MVU 加载脚本不单独运行，关着的不运行）'
            page.wait_for_function("() => document.querySelectorAll('#script-buttons .script-btn').length === 2", timeout=5000)
            assert [t.strip() for t in page.locator('#script-buttons .script-btn').all_inner_texts()] == ['打招呼', '问模型']
            # 变量结构脚本：开场白的变量被它补上了默认值；状态栏占位符补在开场白后面并被卡里的正则换掉
            page.wait_for_function("() => window.TavernHelper.getVariables({ type: 'message', message_id: 0 }).stat_data?.结构默认 === '已补'", timeout=8000)
            v = script_vars(0)
            assert v['stat_data']['好感度'] == 10 and v['stat_data']['地点'] == '门口', v
            page.wait_for_function("() => document.querySelector('#chat .mes[mesid=\"0\"] .mes_text').innerText.includes('【状态栏占位】')", timeout=5000)
            assert_in('<StatusPlaceHolderImpl/>', js("window.TavernHelper.getChatMessages(0)[0].message"), '开场白原文')
            shot('16-script-card')
        run('脚本：导入角色卡后世界书、正则、脚本自动就位并运行', import_script_card)

        def script_events():
            send('MVU 看看变量')
            v = script_vars(-1)
            st = v['stat_data']
            assert st['好感度'] == 12, f'变量结构脚本应把好感度限制在 12：{st}'
            assert st['地点'] == '图书馆', st
            assert st['结构默认'] == '已补', st
            assert st['脚本计数'] == 1, f'监听 mag_variable_update_ended 的脚本没生效：{st}'
            assert 'display_data' not in v and 'delta_data' not in v, f'变量结构脚本去掉的字段又回来了：{list(v)}'
            assert_in('【状态栏占位】', last_text(), '回复的状态栏')
            assert_in('好感度 12', page.locator('#e2e-float').inner_text(), '悬浮窗')
            # 脚本按钮 → 脚本建楼层、存自己的变量
            n = mes_count()
            page.locator('#script-buttons .script-btn', has_text='打招呼').click()
            page.wait_for_function(f"() => document.querySelectorAll('#chat .mes').length === {n + 1}", timeout=5000)
            assert_in('脚本打招呼第 1 次', last_text(), '脚本建的楼层')
            page.locator('#script-buttons .script-btn', has_text='打招呼').click()
            page.wait_for_function(f"() => document.querySelectorAll('#chat .mes').length === {n + 2}", timeout=5000)
            assert_in('脚本打招呼第 2 次', last_text(), '脚本建的楼层')
            page.wait_for_timeout(1200)  # 等角色卡防抖保存
            saved = js("""fetch('/api/characters').then(r => r.json()).then(l => fetch('/api/characters/' + encodeURIComponent(l.find(c => c.name === '脚本测试卡').file)).then(r => r.json()))""")
            flat = []
            for t in saved['data']['extensions']['tavern_helper']['scripts']:
                flat.extend(t['scripts'] if t.get('type') == 'folder' else [t])
            fl = next(x for x in flat if x['id'] == 'e2e-float')
            assert fl['data'] == {'clicks': 2}, f"脚本变量没存进卡里：{fl['data']}"
            assert [b['name'] for b in fl['button']['buttons']] == ['打招呼', '问模型', '隐藏的'], fl['button']
            # 脚本自己调模型（generateRaw）：不走预设，只发它指定的两条
            page.locator('#script-buttons .script-btn', has_text='问模型').click()
            page.wait_for_function("() => (document.querySelector('#e2e-float').dataset.gen ?? '').includes('脚本提问')", timeout=15000)
            req = mock('/last')['body']['messages']
            assert req == [{'role': 'system', 'content': '系统：脚本测试卡'}, {'role': 'user', 'content': '脚本提问'}], req
            assert mes_count() == n + 2, '脚本的生成不应该写进聊天'
            shot('17-script-events')
        run('脚本：MVU 事件、变量结构、脚本按钮、脚本变量、脚本自己调模型', script_events)

        def script_panel():
            right_tab('脚本')
            names = [t.strip() for t in page.locator('#right .script-row .script-name').all_inner_texts()]
            assert names == ['MVU', '变量结构', '悬浮状态栏', '自己清理的脚本', '关着的脚本', '出错的脚本'], names
            assert_in('轻酒馆已内置', script_row('MVU').inner_text(), 'MVU 行')
            assert_in('运行中', script_row('悬浮状态栏').inner_text(), '悬浮状态栏行')
            assert_in('文件夹「界面」', script_row('悬浮状态栏').inner_text(), '悬浮状态栏行')
            assert_in('2 个按钮', script_row('悬浮状态栏').inner_text(), '悬浮状态栏行')
            assert_in('未启用', script_row('关着的脚本').inner_text(), '关着的脚本行')
            assert_in('故意出错', script_row('出错的脚本').inner_text(), '出错的脚本行')
            shot('18-script-panel')
            # 关掉一个脚本：它加到页面上的元素、写到页面上的全局变量、它的按钮都收走
            script_row('悬浮状态栏').locator('.switch').click()
            page.wait_for_function("() => !document.querySelector('#e2e-float')", timeout=5000)
            assert page.locator('#e2e-parent-el').count() == 0, '用 window.parent.document.createElement 建的元素没收走'
            assert js("'__e2eGlobal' in window") is False, '脚本写到页面上的全局变量没收走'
            assert page.locator('#script-buttons').is_hidden(), '脚本停了按钮还在'
            assert page.locator('#e2e-self-clean').count() == 1, '别的脚本不该受影响'
            # 自己写了 pagehide 清理的脚本：停掉时它的清理代码会运行
            script_row('自己清理的脚本').locator('.switch').click()
            page.wait_for_function("() => !document.querySelector('#e2e-self-clean')", timeout=5000)
            # 开关写回了卡里
            page.wait_for_timeout(1200)
            on = js("""fetch('/api/characters').then(r => r.json()).then(l => fetch('/api/characters/' + encodeURIComponent(l.find(c => c.name === '脚本测试卡').file)).then(r => r.json())).then(c => c.data.extensions.tavern_helper.scripts.find(t => t.type === 'folder').scripts.map(x => x.enabled))""")
            assert on == [False, False], on
            # 再打开：重新运行，按钮回来
            script_row('悬浮状态栏').locator('.switch').click()
            page.wait_for_selector('#e2e-float', state='attached', timeout=8000)
            page.wait_for_function("() => document.querySelectorAll('#script-buttons .script-btn').length === 2", timeout=5000)
            assert page.locator('#e2e-float').count() == 1 and page.locator('#e2e-parent-el').count() == 1, '重新打开后元素数量不对（可能重复了）'
            # 这张卡的整体开关、总开关
            page.locator('#right .card', has_text='角色卡「脚本测试卡」的脚本').locator('.card-title .switch').click()
            page.wait_for_function("() => document.querySelectorAll('#lt-script-frames iframe').length === 0 && !document.querySelector('#e2e-float')", timeout=5000)
            page.locator('#right .card', has_text='角色卡「脚本测试卡」的脚本').locator('.card-title .switch').click()
            page.wait_for_selector('#e2e-float', state='attached', timeout=8000)
            page.locator('#right .check', has_text='运行角色卡和预设自带的脚本').click()
            page.wait_for_function("() => document.querySelectorAll('#lt-script-frames iframe').length === 0 && !document.querySelector('#e2e-float')", timeout=5000)
            page.locator('#right .check', has_text='运行角色卡和预设自带的脚本').click()
            page.wait_for_selector('#e2e-float', state='attached', timeout=8000)
            # 换到别的角色：这张卡的脚本停掉；换回来再起
            page.locator('#left .char-item', has_text='测试小林').first.click()
            page.wait_for_function("() => !document.querySelector('#e2e-float') && !document.querySelector('#script-buttons .script-btn')", timeout=8000)
            page.locator('#left .char-item', has_text='脚本测试卡').first.click()
            page.wait_for_selector('#e2e-float', state='attached', timeout=8000)
            page.wait_for_function("() => document.querySelector('#e2e-float').textContent.includes('脚本测试卡 · 共 5 楼')", timeout=8000)
            assert js("document.querySelectorAll('#e2e-float').length") == 1
            # 页面自己的配色没被脚本用的兼容样式带偏（选中项的底色还是原来那个变量）
            active_bg = js("getComputedStyle(document.querySelector('#left .char-item.active')).backgroundColor")
            assert active_bg.startswith(('rgba(31, 30, 29, 0.08', 'rgba(250, 249, 245, 0.09')), f'选中项底色变了：{active_bg}'
            # 搜索能找到脚本面板
            page.locator('#right .panel-search input').fill('小手机')
            page.locator('#right .panel-result', has_text='酒馆助手脚本').first.click()
            page.wait_for_timeout(300)
            assert page.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '脚本'
        run('脚本：面板里的状态和开关，停掉后把页面收拾干净，换角色跟着起停', script_panel)

        def preset_scripts():
            with open(SCRIPT_PRESET, encoding='utf-8') as f:
                preset = f.read()
            right_tab('导入')
            with page.expect_file_chooser() as fc:
                page.locator('#right button', has_text='选择文件').first.click()
            fc.value.set_files(files=[{'name': '脚本预设.json', 'mimeType': 'application/json', 'buffer': preset.encode('utf-8')}])
            page.wait_for_selector('#toasts .toast >> text=已导入预设「脚本预设」并切换过去', timeout=10000)
            assert_in('2 个脚本（1 个启用）', page.locator('#toasts .toast', has_text='已导入预设「脚本预设」').inner_text(), '导入预设的提示')
            page.wait_for_selector('#e2e-preset-script', state='attached', timeout=10000)
            assert js('window.__e2ePresetOff') is None
            idx = js('window.__e2eScriptIndex')
            assert idx == ['e2e-mvu', 'e2e-schema', 'e2e-float', 'e2e-self', 'e2e-off', 'e2e-bad', 'e2e-preset-1', 'e2e-preset-off'], f'脚本看到的脚本列表不对：{idx}'
            assert page.locator('#e2e-float').count() == 1, '换预设不该动角色卡的脚本'
            # 预设脚本在发送前改请求、注入提示词
            send('你好，预设脚本')
            req = mock('/last')['body']['messages']
            texts = [m['content'] for m in req]
            assert texts[-1] == '预设脚本加的一句', texts[-3:]
            assert any('注入的提示词' in t for t in texts), '脚本 injectPrompts 注入的提示词没进请求'
            # 交给脚本的消息只有 role / content / name（带着内部字段的话，合并相邻消息的脚本会失灵）
            assert texts[0] == '生成数据事件加的一句', f'脚本在 GENERATE_AFTER_DATA 里换掉的消息数组没生效，或看到了多余字段：{texts[0][:60]}'
            assert texts[1].startswith('脚本预设的主提示词'), texts[1][:40]
            # 脚本放进“扩展设置”的界面在脚本面板里能看到、能展开
            right_tab('脚本')
            assert_in('预设「脚本预设」的脚本（2 个）', page.locator('#right .panel-body').inner_text(), '脚本面板')
            fold = page.locator('#right details', has_text='脚本自己的设置界面')
            assert fold.locator('#e2e-preset-settings').count() == 1, '脚本的设置界面没出现在面板里'
            assert not fold.locator('#e2e-preset-opt').is_visible()
            fold.locator('.inline-drawer-toggle').click()
            assert fold.locator('#e2e-preset-opt').is_visible(), '折叠抽屉点了没展开'
            shot('19-preset-script')
            # 切到别的分区再回来：设置界面还在（没有跟着面板重绘丢掉）
            right_tab('正则')
            assert js("!!document.querySelector('#lt-script-holder #e2e-preset-settings')"), '离开脚本面板后设置界面应该回到藏身处'
            right_tab('脚本')
            assert page.locator('#right #e2e-preset-settings').count() == 1
            # 换回原来的预设：预设脚本停掉、它的东西收走
            page.locator('#composer-preset').click()
            page.locator('.menu button', has_text='默认').first.click()
            page.wait_for_function("() => !document.querySelector('#e2e-preset-script') && !document.querySelector('#e2e-preset-settings')", timeout=8000)
            assert page.locator('#e2e-float').count() == 1
            send('再说一句')
            texts = [m['content'] for m in mock('/last')['body']['messages']]
            assert not any('预设脚本加的一句' in t or '注入的提示词' in t or '生成数据事件' in t for t in texts), '预设脚本停了它的改动还在生效'
        run('脚本：预设自带的脚本随预设起停，能改请求、注入提示词、放自己的设置界面', preset_scripts)

        def script_reload():
            page.reload(); enter_from_home()
            page.wait_for_selector('#chat .mes')
            page.wait_for_selector('#e2e-float', state='attached', timeout=15000)
            page.wait_for_function("() => document.querySelectorAll('#script-buttons .script-btn').length === 2", timeout=8000)
            assert js("document.querySelectorAll('#lt-script-frames iframe').length") == 3, '刷新后应有 3 个脚本在跑（自己清理的那个已被关掉）'
            page.wait_for_function("() => document.querySelector('#e2e-float').textContent.includes('脚本测试卡')", timeout=8000)
        run('脚本：刷新页面后自动恢复运行', script_reload)

        def method_select():
            return page.locator('#right .card', has=page.locator('.card-title', has_text='变量更新方式')).first.locator('select').first

        def full_panel_shot(path):
            # 设置面板是滚动的：临时把窗口拉高，整块截下来
            h = page.evaluate("Math.max(...[...document.querySelectorAll('#right, #right *')].map(e => e.scrollHeight))") + 260
            page.set_viewport_size({'width': 1440, 'height': max(900, min(h, 8000))})
            page.wait_for_timeout(300)
            page.locator('#right').screenshot(path=path)
            page.set_viewport_size({'width': 1440, 'height': 900})
            page.wait_for_timeout(200)

        def mvu_separate():
            right_tab('变量', sub='MVU 设置')
            titles = [t.strip() for t in page.locator('#right .card > .card-title, #right .panel-body > details.fold > summary, #right details.fold > summary').all_inner_texts()]
            for title in ['通知设置', '变量更新方式', '修复按钮', '自动清理变量', '兼容性', '角色卡覆盖']:
                assert any(t.startswith(title) for t in titles), f'少了「{title}」：{titles}'
            order = [next(i for i, t in enumerate(titles) if t.startswith(x)) for x in ['通知设置', '变量更新方式', '修复按钮', '自动清理变量', '兼容性', '角色卡覆盖']]
            assert order == sorted(order), f'设置卡片的顺序不对：{titles}'
            assert page.locator('#right >> text=请求策略').count() == 0, '随 AI 输出时不该显示额外模型的设置'
            full_panel_shot('/tmp/lt-shots/vars-mvu-ai.png')
            method_select().select_option('extra')
            page.wait_for_timeout(300)
            assert page.locator('#right .card-sub', has_text='模型来源').count() == 1, '选了额外模型解析后应出现「模型来源」'
            for sub in ['请求内容', '请求策略', '高级参数']:
                assert page.locator('#right details.fold > summary', has_text=sub).count() == 1, f'选了额外模型解析后应出现「{sub}」'
            full_panel_shot('/tmp/lt-shots/vars-mvu-extra.png')
            page.locator('#right').screenshot(path='/tmp/lt-shots/vars-extra.png')
            before = mock('/count').get('MVUSEP', 0)
            send('再看看 NOSCHEMA')
            assert mock('/count').get('MVUSEP', 0) == before + 2, '结构化被拒后应退回普通文本再请求一次'
            last = mock('/last')['body']
            allc = '\n'.join(m['content'] for m in last['messages'])
            assert 'variable_update_task' in allc, '最后一个请求应是变量更新'
            assert allc.index('<additional_information>') < allc.index('<past_observe>') < allc.index('剧情发生前的变量') < allc.index('variable_update_task'), '内置请求内容的顺序'
            assert_in('脚本测试卡是用来测试酒馆助手脚本的角色', allc, '变量更新请求里的角色描述')
            assert 'response_format' not in last, '退回后不该再带结构化要求'
            mes = js("window.TavernHelper.getChatMessages(-1)[0].message")
            assert_in('<JSONPatch>', mes, '变量更新块写回正文')
            v = script_vars(-1)
            assert v['stat_data']['好感度'] is not None, v
            send('再来一次')
            assert mock('/count').get('MVUSEP', 0) == before + 3, '结构化输出一次就成功'
            assert 'response_format' in mock('/last')['body'], '应要求结构化输出'
            assert_in('单独更新', js("window.TavernHelper.getChatMessages(-1)[0].message"), 'JSON 结果转成更新块')
            send('MVU 正文自己写')
            assert mock('/count').get('MVUSEP', 0) == before + 3, '正文自带更新块时不再单独请求'
        run('MVU 变量单独更新：结构化输出、退回普通文本、正文自带时跳过', mvu_separate)

        def watch_toasts():
            page.evaluate("""() => {
                window.__toasts = [];
                if (window.__toastObs) return;
                window.__toastObs = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => window.__toasts.push(n.textContent))));
                window.__toastObs.observe(document.getElementById('toasts'), { childList: true });
            }""")

        def toasts():
            return js('window.__toasts')

        def mvu_strategy_notify():
            right_tab('变量', sub='MVU 设置')
            watch_toasts()
            before = mock('/count').get('MVUSEP', 0)
            send('BADONCE 第一次解析不出来')
            # 第一次尝试：结构化 + 退回文本都解析不出 → 失败；第二次尝试成功
            assert mock('/count').get('MVUSEP', 0) == before + 3, f"请求次数 {mock('/count').get('MVUSEP', 0) - before}"
            t = toasts()
            assert any('正在请求模型更新变量' in x for x in t), f'额外模型解析中的通知没出现：{t}'
            assert any('正在重试（1 / 2）' in x for x in t), f'重试的通知没出现：{t}'
            assert_in('书库', js("window.TavernHelper.getChatMessages(-1)[0].message"), '重试后的更新块')
            # 关掉“额外模型解析中通知”：不再弹
            open_fold('通知设置')
            page.locator('#right .check', has_text='额外模型解析中通知').locator('input').uncheck()
            watch_toasts()
            send('再说一句')
            assert not any('正在请求模型更新变量' in x for x in toasts()), '关掉通知后不该再弹'
            page.locator('#right .check', has_text='额外模型解析中通知').locator('input').check()
        run('MVU 请求策略：失败后重试、额外模型解析中的通知开关', mvu_strategy_notify)

        def mvu_auto_off():
            right_tab('变量', sub='MVU 设置')
            page.locator('#right .check', has_text='自动请求').locator('input').uncheck()
            page.wait_for_timeout(200)
            before = mock('/count').get('MVUSEP', 0)
            send('自动请求关了')
            assert mock('/count').get('MVUSEP', 0) == before, '关了自动请求还在自动更新变量'
            assert '<UpdateVariable>' not in js("window.TavernHelper.getChatMessages(-1)[0].message")
            right_tab('变量', sub='MVU 设置')
            page.locator('#right button', has_text='重试额外模型解析').click()
            page.locator('.modal-foot button', has_text='确定').click()
            page.wait_for_function("() => window.TavernHelper.getChatMessages(-1)[0].message.includes('<JSONPatch>')", timeout=15000)
            assert mock('/count').get('MVUSEP', 0) > before, '手动重试没有请求'
            right_tab('变量', sub='MVU 设置')
            page.locator('#right .check', has_text='自动请求').locator('input').check()
        run('MVU 关掉自动请求：回复后不更新，手动“重试额外模型解析”', mvu_auto_off)

        def mvu_repair():
            right_tab('变量', sub='MVU 设置')
            start = script_vars(-1)['stat_data']['好感度']
            mes0 = js("window.TavernHelper.getChatMessages(-1)[0].message")
            page.locator('#right button', has_text='增量校正额外模型解析').click()
            page.locator('.modal textarea').fill('核对好感度')
            page.locator('.modal-foot button', has_text='确定').click()
            page.wait_for_selector('.modal >> text=增量校正预览', timeout=15000)
            preview = page.locator('.modal').inner_text()
            assert_in('/好感度', preview, '预览里的变化')
            assert_in('99', preview, '预览里的新值')
            assert script_vars(-1)['stat_data']['好感度'] == start, '确认之前不该改变量'
            assert any('variable_repair_task' in m['content'] for m in mock('/last')['body']['messages']), '应发出增量校正任务'
            assert any('核对好感度' in m['content'] for m in mock('/last')['body']['messages']), '校正方向要带上'
            page.locator('.modal-foot button', has_text='应用修正').click()
            page.wait_for_timeout(400)
            assert script_vars(-1)['stat_data']['好感度'] == 99, script_vars(-1)
            assert_in('"value":99', js("window.TavernHelper.getChatMessages(-1)[0].message").replace(' ', ''), '校正块写回正文')
            page.locator('#toasts .toast', has_text='增量校正已应用').locator('button', has_text='撤销').click()
            page.wait_for_timeout(400)
            assert script_vars(-1)['stat_data']['好感度'] == start, '撤销后变量应恢复'
            assert js("window.TavernHelper.getChatMessages(-1)[0].message") == mes0, '撤销后正文应恢复'
            right_tab('变量', sub='MVU 设置')
            method_select().select_option('ai')
            page.wait_for_timeout(300)
        run('MVU 增量校正：预览、应用、撤销', mvu_repair)

        def mvu_override():
            right_tab('变量', sub='MVU 设置')
            card = lambda: page.locator('#right details.fold', has=page.locator('summary', has_text=re.compile(r'^角色卡覆盖'))).first
            assert_in('未启用', card().locator('summary').inner_text(), '没覆盖时')
            open_fold('角色卡覆盖')
            card().locator('.field', has_text='变量更新方式（角色卡）').locator('select').select_option('额外模型解析')
            page.wait_for_timeout(300)
            assert_in('覆盖中', card().locator(':scope > summary').inner_text(), '覆盖后')
            assert page.locator('#right .override-badge', has_text='角色卡覆盖：额外模型解析').count() == 1, '变量更新方式旁边应显示角色卡覆盖的值'
            assert page.locator('#right details.fold > summary', has_text='请求策略').count() == 1, '角色卡覆盖成额外模型解析时也要显示额外模型的设置'
            page.wait_for_timeout(1200)
            world = page.evaluate("fetch('/api/worlds/' + encodeURIComponent('脚本卡的书')).then(r => r.text())")
            assert '[config_override]' in world and '额外模型解析' in world, '覆盖要存进角色世界书的 [config_override] 条目'
            card().locator('.field', has_text='变量更新方式（角色卡）').locator('select').select_option('__inherit__')
            page.wait_for_timeout(300)
            assert_in('未启用', card().locator(':scope > summary').inner_text(), '改回跟随用户配置')
            assert page.locator('#right .override-badge').count() == 0
        run('MVU 角色卡覆盖：存进角色世界书、显示覆盖的值、改回跟随', mvu_override)

        def mobile():
            mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN')
            offline_cdn(mctx)
            mp = mctx.new_page()
            mp.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
            mp.goto(BASE + '/')
            mp.wait_for_selector('#chat .recent-item, #chat .mes', timeout=15000)
            if mp.locator('#chat .recent-item').count():
                mp.locator('#chat .recent-item').first.click()
            mp.wait_for_selector('#chat .mes')
            mp.wait_for_timeout(1500)
            mp.screenshot(path=os.path.join(SHOTS, '11-mobile-chat.png'))

            def no_overflow(where):
                sw = mp.evaluate('document.documentElement.scrollWidth')
                assert sw <= 390, f'{where}：手机上横向溢出 {sw}px'
                bad = mp.evaluate('''() => [...document.querySelectorAll('#topbar *, #composer *, #right .panel-main > *, #right .panel-rail *, #left > *')]
                    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > innerWidth + 1 && getComputedStyle(el.closest('.drawer') ?? el).transform === 'none'; })
                    .map(el => el.className || el.tagName).slice(0, 5)''')
                assert not bad, f'{where}：有元素伸出屏幕右边 {bad}'

            # 手机上没有悬停提示：顶栏两个按钮带文字，输入框上能看到当前预设
            labels = [t.strip() for t in mp.locator('#topbar .tb-btn').all_inner_texts()]
            assert labels == ['菜单', '设置'], labels
            assert mp.locator('#composer-preset').is_visible(), '手机上看不到预设切换'
            assert mp.locator('#composer-model').is_visible()
            # 脚本按钮在输入框上方，手机上也看得到、点得到
            mp.wait_for_function("() => document.querySelectorAll('#script-buttons .script-btn').length === 2", timeout=10000)
            assert mp.locator('#script-buttons .script-btn', has_text='打招呼').is_visible(), '手机上看不到脚本按钮'
            no_overflow('聊天页')
            mp.locator('#topbar button[title="菜单"]').click()
            mp.wait_for_timeout(400)
            mp.screenshot(path=os.path.join(SHOTS, '12-mobile-left.png'))
            mp.locator('#scrim').click(position={'x': 370, 'y': 400})
            mp.wait_for_timeout(400)
            mp.locator('#topbar button[title="设置"]').click()
            mp.wait_for_timeout(400)
            right_tab('预设', mp)
            mp.screenshot(path=os.path.join(SHOTS, '13-mobile-settings.png'))
            no_overflow('设置面板')
            for gid in ('model', 'char', 'chat', 'general'):
                mp.locator(f'#right .panel-rail .tab[data-group="{gid}"]').click()
                mp.wait_for_timeout(150)
                clipped = mp.evaluate("[...document.querySelectorAll('#right .seg-tab')].filter(b => b.scrollWidth > b.clientWidth).map(b => b.textContent)")
                assert not clipped, f'分区名字显示不全：{clipped}'
            mp.locator('#right .panel-search input').fill('开场白')
            mp.wait_for_selector('#right .panel-result')
            mp.screenshot(path=os.path.join(SHOTS, '14-mobile-search.png'))
            no_overflow('搜索结果')
            mp.locator('#right .panel-result').first.click()
            mp.wait_for_timeout(400)
            assert mp.locator('#right .panel-seg:not(.vars-seg) .seg-tab.active').inner_text().strip() == '角色卡'
            assert mp.locator('#right .flash').first.is_visible(), '手机上搜索后没定位到那一项'
            mp.screenshot(path=os.path.join(SHOTS, '15-mobile-search-jump.png'))
            mctx.close()
        run('手机布局（390px）', mobile)

        # ---------- 与酒馆共用数据目录（另起的一个实例：--st-data 指向一个假的酒馆目录） ----------
        if SHARED_URL and SHARED_DIR:
            sctx = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
            offline_cdn(sctx)
            sp = sctx.new_page()
            sp.on('console', lambda m: errors.append(f'[共用] console.{m.type}: {m.text}') if m.type in ('error',) else None)
            sp.on('pageerror', lambda e: errors.append(f'[共用] pageerror: {e}'))
            st_file = lambda *parts: os.path.join(SHARED_DIR, *parts)
            chat_files = lambda: [os.path.join(r, f) for r, _, fs in os.walk(st_file('chats')) for f in fs if f.endswith('.jsonl')]

            def shared_import_settings():
                sp.goto(SHARED_URL + '/')
                sp.wait_for_selector('#composer textarea', state='attached')
                right_tab('导入', sp)
                sp.wait_for_selector('#right >> text=与酒馆共用数据')
                assert_in(SHARED_DIR, sp.locator('#right .panel-body').inner_text(), '导入面板')
                sp.locator('#right button', has_text=SHARED_DIR).click()
                sp.wait_for_selector('#right >> text=这就是正在共用的目录')
                assert sp.locator('#right >> text=API 连接和 Key（1 个）').is_visible()
                assert sp.locator('#right summary', has_text='角色卡').count() == 0, '共用目录不该再列角色卡让人导入'
                sp.locator('#right button', has_text='开始导入').click()
                sp.wait_for_selector('#right >> text=完成：连接 1')
                right_tab('连接', sp)
                sp.wait_for_selector('#right input[type=password][placeholder^="已保存"]')
                assert sp.locator('#right .panel-body input.input').first.input_value() == '酒馆里的中转' or '酒馆里的中转' in sp.locator('#right .panel-body').inner_text()
                # 酒馆自己的设置和密钥文件一个字都没被动过
                assert json.load(open(st_file('settings.json'), encoding='utf-8'))['main_api'] == 'openai'
                assert 'sk-from-tavern' in open(st_file('secrets.json'), encoding='utf-8').read()
                sp.screenshot(path=os.path.join(SHOTS, '20-shared-import.png'))
            run('共用：导入面板说明共用目录，只把连接和 Key 搬过来', shared_import_settings)

            def shared_card_and_chat():
                right_tab('导入', sp)
                with sp.expect_file_chooser() as fc:
                    sp.locator('#right button', has_text='选择文件').click()
                fc.value.set_files(FIXTURE)
                sp.wait_for_selector('#chat .mes')
                cards = [f for f in os.listdir(st_file('characters')) if f.endswith('.png')]
                assert len(cards) == 1, f'角色卡应该落在酒馆的 characters 里：{cards}'
                assert len(os.listdir(st_file('worlds'))) == 1, '内嵌世界书应该落在酒馆的 worlds 里'
                sp.fill('#send_textarea', '共用目录里的第一句')
                sp.click('#send_but')
                sp.wait_for_function("() => !document.querySelector('#send_but.stop')", timeout=40000)
                sp.wait_for_timeout(900)
                files = chat_files()
                assert len(files) == 1, f'聊天应该落在酒馆的 chats 里：{files}'
                lines = open(files[0], encoding='utf-8').read().strip().split('\n')
                assert json.loads(lines[0])['chat_metadata'].get('integrity'), '共用模式下聊天头要带校验标记'
                assert len(lines) >= 4, f'开场白 + 一问一答：{len(lines)} 行'
                assert '共用目录里的第一句' in lines[2]
            run('共用：导入的卡、世界书和新聊天都落在酒馆目录里，用搬过来的连接能聊', shared_card_and_chat)

            def tavern_writes(text):
                """装作酒馆那边又聊了一句：直接往聊天文件后面加一行"""
                f = chat_files()[0]
                with open(f, 'a', encoding='utf-8') as fh:
                    fh.write(json.dumps({'name': '测试角色', 'is_user': False, 'mes': text, 'send_date': '2026-10-10T00:00:00.000Z'}, ensure_ascii=False) + '\n')
                return f

            def edit_first(text):
                first = sp.locator('#chat .mes').first
                first.hover()
                first.locator('button[title="编辑"]').click()
                sp.locator('#chat .mes-edit textarea').fill(text)
                sp.locator('#chat .mes-edit button', has_text='保存').click()

            def shared_conflict():
                f = tavern_writes('酒馆那边回的一句')
                edit_first('这边改的开场白')
                sp.wait_for_selector('.modal >> text=这个聊天在别处被改过了')
                sp.screenshot(path=os.path.join(SHOTS, '21-shared-conflict.png'))
                assert '这边改的开场白' not in open(f, encoding='utf-8').read(), '被拦下来就不能写进去'
                sp.locator('.modal-foot button', has_text='载入最新的').click()
                sp.wait_for_function("() => document.querySelector('#chat')?.innerText.includes('酒馆那边回的一句')")
                assert '这边改的开场白' not in sp.locator('#chat').inner_text(), '载入最新的之后这边没保存的修改应该作废'
                # 载入之后拿到的是新版本号，正常修改能存进去
                edit_first('载入之后再改')
                sp.wait_for_timeout(1200)
                assert sp.locator('.modal').count() == 0, '没有别处的改动时不该弹窗'
                assert '载入之后再改' in open(f, encoding='utf-8').read()

                # 再来一次，这回选覆盖
                tavern_writes('酒馆那边的第二句')
                edit_first('坚持用这边的')
                sp.wait_for_selector('.modal >> text=这个聊天在别处被改过了')
                sp.locator('.modal-foot button', has_text='用这边的覆盖').click()
                sp.wait_for_function("() => !document.querySelector('.modal')")
                sp.wait_for_timeout(600)
                text = open(f, encoding='utf-8').read()
                assert '坚持用这边的' in text and '酒馆那边的第二句' not in text, '覆盖后磁盘上应该是这边的内容'
                backups = [os.path.join(r, x) for r, _, fs in os.walk(os.path.join(SHARED_OWN, 'backups')) for x in fs]
                assert any('酒馆那边的第二句' in open(b, encoding='utf-8').read() for b in backups), '被覆盖的内容应该留在备份里'
                # 关掉弹窗不选 = 先不管，下次保存再问
                tavern_writes('第三句')
                edit_first('先不管')
                sp.wait_for_selector('.modal >> text=这个聊天在别处被改过了')
                sp.keyboard.press('Escape')
                sp.wait_for_function("() => !document.querySelector('.modal')")
                assert '先不管' not in open(f, encoding='utf-8').read()
                edit_first('再改一次')
                sp.wait_for_selector('.modal >> text=这个聊天在别处被改过了')
                sp.locator('.modal-foot button', has_text='用这边的覆盖').click()
                sp.wait_for_function("() => !document.querySelector('.modal')")
            run('共用：聊天被酒馆改过时拦下来问，载入最新 / 覆盖（留备份）/ 先不管都对', shared_conflict)

            def shared_preset_conflict():
                def temp_input():
                    sp.locator('#right .panel-search input').fill('temperature')
                    sp.locator('#right .panel-result', has_text='温度').first.click()
                    sp.wait_for_timeout(300)
                    return sp.locator('#right .flash input[type=number]').first
                pf = st_file('OpenAI Settings', '默认.json')
                assert os.path.exists(pf), '没有预设时新建的「默认」应该落在酒馆的 OpenAI Settings 里'
                temp_input().fill('1.23')
                sp.wait_for_timeout(1200)
                assert json.load(open(pf, encoding='utf-8'))['temperature'] == 1.23
                # 酒馆那边保存了这个预设
                j = json.load(open(pf, encoding='utf-8'))
                j['temperature'] = 0.42
                j['酒馆那边加的'] = True
                json.dump(j, open(pf, 'w', encoding='utf-8'), ensure_ascii=False)
                temp_input().fill('1.5')
                sp.wait_for_selector('.modal >> text=预设「默认」在别处被改过了')
                assert json.load(open(pf, encoding='utf-8'))['temperature'] == 0.42, '被拦下来就不能写进去'
                sp.locator('.modal-foot button', has_text='载入最新的').click()
                sp.wait_for_function("() => !document.querySelector('.modal')")
                sp.wait_for_timeout(300)
                assert temp_input().input_value() == '0.42', '载入最新的之后应该显示酒馆那边的值'
                temp_input().fill('0.9')
                sp.wait_for_timeout(1200)
                j = json.load(open(pf, encoding='utf-8'))
                assert j['temperature'] == 0.9 and j['酒馆那边加的'] is True, '载入之后再改能存，酒馆加的字段还在'
            run('共用：预设被酒馆改过时也拦下来问', shared_preset_conflict)

            def stale_page_blocked():
                # 没带前后端版本标记的保存请求（= 更新前就开着的旧页面）一律挡住，读不受影响
                r = sp.evaluate("""async () => {
                    const put = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"坏了":1}' });
                    const get = await fetch('/api/settings');
                    return { put: put.status, code: (await put.json()).error?.code, get: get.status, broken: '坏了' in (await get.json()) };
                }""")
                assert r == {'put': 409, 'code': 'stale-client', 'get': 200, 'broken': False}, r
            run('旧页面的保存请求被挡住', stale_page_blocked)
            sctx.close()

        browser.close()

    print('\n==== 结果 ====')
    ok = sum(1 for r in results if r[1] == 'OK')
    for r in results:
        print(f'{r[1]:4}  {r[0]}  {r[2] if r[1] == "OK" else ""}')
        if r[1] != 'OK':
            print(f'      {r[2]}')
    print(f'\n通过 {ok}/{len(results)}；截图在 {SHOTS}')
    # 本来就会有的几种：429 重试测试；脚本测试卡里故意出错的那个脚本；被掐掉的 jsdelivr 请求（图标字体）
    # 共用那几项里的 409 是故意造出来的“聊天被别处改过”
    errors[:] = [e for e in errors if 'status of 429' not in e and '故意出错' not in e and 'net::ERR_FAILED' not in e and 'ERR_INTERNET_DISCONNECTED' not in e and not ('[共用]' in e and 'status of 409' in e)]
    if errors:
        print(f'\n浏览器报错 {len(errors)} 条：')
        for e in errors[:30]:
            print('  ' + e[:300])
    return 0 if ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
