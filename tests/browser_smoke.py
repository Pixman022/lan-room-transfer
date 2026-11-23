"""Real Chromium UI + local WebSocket signalling smoke test, not a physical P2P test.

Start `python server.py` separately. Uses two browser contexts on one host:
it validates room membership and user interaction, NOT actual LAN paths or
cross-device file delivery.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = os.getenv('LAN_ROOM_TEST_URL', 'http://127.0.0.1:8765')
BINARY = os.getenv('CHROMIUM_BINARY')
SCREENSHOT_DIR = Path(__file__).resolve().parents[1] / 'docs'


def rename(page, button, label, name):
    page.locator(button).click()
    editor = page.locator(label)
    assert editor.get_attribute('contenteditable') == 'plaintext-only'
    editor.fill(name)
    editor.press('Enter')
    assert editor.get_attribute('contenteditable') == 'false'
    assert editor.inner_text() == name


with sync_playwright() as playwright:
    options = {'headless': True}
    if BINARY:
        options['executable_path'] = BINARY
    browser = playwright.chromium.launch(**options)
    one = browser.new_context(viewport={'width': 1280, 'height': 900})
    two = browser.new_context(viewport={'width': 390, 'height': 844})
    # Observe the real sockets so the smoke test can cause an unexpected
    # signalling-only close without mutating production application code.
    for context in (one, two):
        context.add_init_script("""() => {
            const NativeWebSocket = window.WebSocket;
            window.__smokeWebSockets = [];
            window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
                constructor(...args) {
                    super(...args);
                    window.__smokeWebSockets.push(this);
                }
            };
        }""".replace("() => {", "(() => {").replace("\n        }", "\n        })()"))
    a, b = one.new_page(), two.new_page()
    errors = []
    for page in (a, b):
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto(ROOT)

    # The name is displayed as editable text; the old standalone inputs are gone.
    assert a.locator('#device-name').count() == 0
    assert a.locator('#room-device-name').count() == 0
    initial = a.locator('#home-device-label').inner_text()
    assert initial and initial != 'My device'
    code = a.locator('#room-code-input').input_value()
    assert len(code) == 4 and code.isdigit()
    a.reload()
    assert a.locator('#home-device-label').inner_text() == initial, 'device name was not persisted'

    rename(a, '#edit-home-device-name', '#home-device-label', 'Windows Laptop')
    assert a.locator('#toast-message').inner_text() == '设备名称已修改'
    a.locator('#room-code-input').fill('home2026')
    a.locator('#enter-room').click()
    a.locator('#room-screen').wait_for(state='visible')
    assert a.locator('#room-name').inner_text() == 'HOME2026'

    rename(b, '#edit-home-device-name', '#home-device-label', 'Mobile Phone')
    b.locator('#room-code-input').fill('HOME2026')
    b.locator('#enter-room').click()
    b.locator('#room-screen').wait_for(state='visible')

    a.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    b.locator('#peer-list').get_by_text('Windows Laptop').wait_for()
    assert a.locator('#peer-list .device-row').count() == 1
    assert b.locator('#peer-list .device-row').count() == 1
    assert a.locator('#peer-list .device-row button').count() == 0
    assert a.locator('#send-target').count() == 0
    assert a.locator('#transfer-jobs').count() == 0

    a.locator('#toggle-diagnostics').click()
    assert a.locator('#diagnostics-panel').is_visible()
    assert a.locator('#diagnostics-content').inner_text().strip()
    a.locator('#toggle-diagnostics').click()

    with a.expect_file_chooser() as chooser:
        a.locator('#drop-zone').click()
    chooser.value.set_files({'name': 'smoke.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
    assert a.locator('#sent-files .file-row').count() == 1
    assert 'smoke.txt' in a.locator('#sent-files').inner_text()

    rename(a, '#edit-device-name', '#my-device-label', 'Updated Laptop')
    assert a.locator('#toast-message').inner_text() == '设备名称已修改'
    b.locator('#peer-list').get_by_text('Updated Laptop').wait_for()
    assert b.locator('#peer-list').get_by_text('Windows Laptop').count() == 0
    for page, name in ((a, 'desktop'), (b, 'mobile')):
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), name + ' horizontal overflow'
        page.screenshot(path=str(SCREENSHOT_DIR / (name + '-ui.png')), full_page=True)
    assert not errors, errors

    # R05 control-plane variant: B's socket closes unexpectedly, A stays
    # online, and B must automatically resume its *existing* room identity.
    # This same-machine test cannot assert B/C P2P path or file-byte recovery.
    b.locator('#toggle-diagnostics').click()
    assert len(b.evaluate('window.__smokeWebSockets')) == 1
    b.evaluate('window.__smokeWebSockets[0].close(1012, "test interruption")')
    b.wait_for_function("""() =>
        window.__smokeWebSockets.length >= 2 &&
        window.__smokeWebSockets.at(-1).readyState === WebSocket.OPEN &&
        document.getElementById('diagnostics-content').textContent.includes('房间进入：resumed')
    """, timeout=15000)
    b.locator('#peer-list').get_by_text('Updated Laptop').wait_for()
    assert b.locator('#room-name').inner_text() == 'HOME2026'
    b.locator('#toggle-diagnostics').click()

    b.locator('#leave-room').click()
    b.locator('#home-screen').wait_for(state='visible')
    a.locator('#peer-list .device-row').wait_for(state='hidden')

    # R06 control-plane variant: A is the last online device. On unexpected
    # socket close the server releases the room; the *same open browser tab*
    # automatically creates a fresh room with the old code and retains its
    # locally staged File object, without refreshing or clicking Enter.
    a.locator('#toggle-diagnostics').click()
    assert len(a.evaluate('window.__smokeWebSockets')) == 1
    a.evaluate('window.__smokeWebSockets[0].close(1012, "test interruption")')
    a.wait_for_function("""() =>
        window.__smokeWebSockets.length >= 2 &&
        window.__smokeWebSockets.at(-1).readyState === WebSocket.OPEN &&
        document.getElementById('feedback').textContent.includes('原房间已关闭')
    """, timeout=15000)
    assert '房间进入：created' in a.locator('#diagnostics-content').inner_text()
    assert a.locator('#room-name').inner_text() == 'HOME2026'
    assert a.locator('#sent-files .file-row').count() == 1
    assert 'smoke.txt' in a.locator('#sent-files').inner_text()
    a.locator('#toggle-diagnostics').click()
    assert not errors, errors
    a.locator('#leave-room').click()
    a.locator('#home-screen').wait_for(state='visible')
    browser.close()
    print('PASS: local HTTP/WebSocket join, rename, file staging, R05 session resume, R06 fresh room with staged File')
    print('LIMIT: same-host browsers and induced WebSocket close; no physical network outage, routed P2P or file-byte proof')
