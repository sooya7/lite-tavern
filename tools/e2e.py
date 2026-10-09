# 端到端测试：无头浏览器跑一遍主要流程（连接、导入卡、MVU、前端卡、世界书、EJS、重刷、重试、停止、编辑、
# 提示词预览、Claude/Gemini 格式、刷新恢复、手机布局）。依赖：python playwright + tools/mock-llm.mjs。
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


def right_tab(label):
    page.locator('#right .tab', has_text=label).first.click()
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
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

        def open_app():
            page.goto(BASE + '/')
            page.wait_for_selector('#composer textarea')
            page.wait_for_timeout(500)
            shot('01-first-run')
        run('打开首页', open_app)

        def setup_connection():
            if not page.locator('#app').get_attribute('class').count('right-closed') == 0:
                page.locator('#topbar button[title="设置面板"]').click()
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
                page.locator('#left button[title^="导入角色卡"]').click()
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
            right_tab('提示词')
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

        def light_theme():
            page.locator('#topbar button[title="切换深浅色"]').click()
            page.wait_for_timeout(300)
            assert page.evaluate("document.documentElement.dataset.theme") == 'light'
            shot('08-light')
            page.locator('#topbar button[title="切换深浅色"]').click()
        run('切换浅色主题', light_theme)

        def mobile():
            mctx = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, locale='zh-CN')
            mp = mctx.new_page()
            mp.on('pageerror', lambda e: errors.append(f'mobile pageerror: {e}'))
            mp.goto(BASE + '/')
            mp.wait_for_selector('#chat .mes')
            mp.wait_for_timeout(1500)
            mp.screenshot(path=os.path.join(SHOTS, '09-mobile-chat.png'))
            mp.locator('#topbar button[title="角色列表"]').click()
            mp.wait_for_timeout(400)
            mp.screenshot(path=os.path.join(SHOTS, '10-mobile-left.png'))
            mp.locator('#scrim').click(position={'x': 370, 'y': 400})
            mp.wait_for_timeout(400)
            mp.locator('#topbar button[title="设置面板"]').click()
            mp.wait_for_timeout(400)
            mp.screenshot(path=os.path.join(SHOTS, '11-mobile-right.png'))
            sw = mp.evaluate('document.documentElement.scrollWidth')
            assert sw <= 390, f'手机上横向溢出 {sw}px'
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
