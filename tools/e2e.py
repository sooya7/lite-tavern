# 端到端测试：无头浏览器跑一遍主要流程（连接、导入卡、MVU、前端卡、世界书、EJS、重刷、重试、停止、编辑、
# 提示词预览、Claude/Gemini 格式、设置面板分组与搜索、菜单入口、刷新恢复、手机布局）。依赖：python playwright + tools/mock-llm.mjs。
# 用法：先起 mock（node tools/mock-llm.mjs 8799）和服务（node server.mjs --port 8731 --data <空目录>），再
#   python tools/e2e.py
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get('LT_URL', 'http://127.0.0.1:8731')
MOCK = os.environ.get('MOCK_URL', 'http://127.0.0.1:8799')
SHOTS = os.environ.get('LT_SHOTS', os.path.join(os.environ.get('TEMP', '/tmp'), 'lt-shots'))
FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'test-card.json')
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


# 设置面板：分区 → 所在分组（和 public/js/ui/panels/nav.js 一致）
SECTION_GROUP = {
    '连接': 'model', '预设': 'model',
    '角色卡': 'char', '世界书': 'char', '正则': 'char',
    '作者注释': 'chat', '变量': 'chat', '提示词预览': 'chat',
    '用户设定': 'general', '外观与行为': 'general', '导入': 'general',
}


def open_settings(pg=None):
    pg = pg or page
    if 'right-closed' in pg.locator('#app').get_attribute('class'):
        pg.locator('#topbar button[title="设置"]').click()
        pg.wait_for_timeout(300)


def right_tab(label, pg=None):
    """打开设置面板里的某个分区：先点左边的分组，再点顶上的分区"""
    pg = pg or page
    open_settings(pg)
    pg.locator(f'#right .panel-rail .tab[data-group="{SECTION_GROUP[label]}"]').click()
    pg.locator('#right .seg-tab', has_text=label).first.click()
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
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, locale='zh-CN')
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
            right_tab('变量')
            page.wait_for_selector('#right >> text=MVU 已启用')
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

        def reload_restore():
            n = mes_count()
            page.reload()
            page.wait_for_selector('#chat .mes')
            page.wait_for_timeout(1500)
            assert mes_count() == n, f'刷新后消息数 {mes_count()}（应为 {n}）'
        run('刷新后恢复上次聊天', reload_restore)

        def settings_groups():
            open_settings()
            groups = [t.strip() for t in page.locator('#right .panel-rail .tab').all_inner_texts()]
            assert groups == ['模型', '角色', '本聊天', '通用'], groups
            want = {
                'model': ['连接', '预设'],
                'char': ['角色卡', '世界书', '正则'],
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
                    assert page.locator('#right .seg-tab.active').inner_text().strip() == sec
                    assert '面板出错' not in page.locator('#right .panel-body').inner_text(), f'{sec} 渲染出错'
            # 分组记得上次停在哪个分区
            right_tab('世界书')
            page.locator('#right .panel-rail .tab[data-group="model"]').click()
            page.locator('#right .panel-rail .tab[data-group="char"]').click()
            page.wait_for_timeout(120)
            assert page.locator('#right .seg-tab.active').inner_text().strip() == '世界书'
            shot('08-settings-groups')
        run('设置面板：4 个分组、11 个分区都能打开', settings_groups)

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
            assert page.locator('#right .seg-tab.active').inner_text().strip() == '外观与行为'
            assert_in('正文字号', page.locator('#right .flash').first.inner_text(), '定位到的那一项')
            assert box.input_value() == '', '跳过去之后搜索框应该清空'
            # 折叠块里的项：先展开再定位
            box.fill('temperature')
            page.locator('#right .panel-result', has_text='温度').first.click()
            page.wait_for_timeout(300)
            assert page.locator('#right .seg-tab.active').inner_text().strip() == '预设'
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
            assert [n.split('\n')[0] for n in nav] == ['新聊天', '角色库'], nav
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
            assert page.locator('#right .seg-tab.active').inner_text().strip() == '预设'
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
            page.reload()
            page.wait_for_selector('#chat .mes')
            assert page.evaluate("document.documentElement.dataset.theme") == after, '刷新后主题没保住'
            right_tab('外观与行为')
            page.locator('#right .field', has_text='主题').locator('select').select_option('auto')
            page.wait_for_timeout(300)
            assert page.evaluate("document.documentElement.dataset.theme") == before
        run('在设置里切换深浅色并在刷新后保持', toggle_theme)

        def mobile():
            mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN')
            mp = mctx.new_page()
            mp.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
            mp.goto(BASE + '/')
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
            assert mp.locator('#right .seg-tab.active').inner_text().strip() == '角色卡'
            assert mp.locator('#right .flash').first.is_visible(), '手机上搜索后没定位到那一项'
            mp.screenshot(path=os.path.join(SHOTS, '15-mobile-search-jump.png'))
            mctx.close()
        run('手机布局（390px）', mobile)

        browser.close()

    print('\n==== 结果 ====')
    ok = sum(1 for r in results if r[1] == 'OK')
    for r in results:
        print(f'{r[1]:4}  {r[0]}  {r[2] if r[1] == "OK" else ""}')
        if r[1] != 'OK':
            print(f'      {r[2]}')
    print(f'\n通过 {ok}/{len(results)}；截图在 {SHOTS}')
    errors[:] = [e for e in errors if 'status of 429' not in e]  # 429 重试测试本来就会产生一条
    if errors:
        print(f'\n浏览器报错 {len(errors)} 条：')
        for e in errors[:30]:
            print('  ' + e[:300])
    return 0 if ok == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
