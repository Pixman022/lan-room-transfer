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
        context.add_init_script("""(() => {
            const NativeWebSocket = window.WebSocket;
            window.__smokeWebSockets = [];
            window.WebSocket = class TrackedWebSocket extends NativeWebSocket {
                constructor(...args) {
                    super(...args);
                    window.__smokeWebSockets.push(this);
                }
            };
        })();""")
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

    # A second tab in the same profile shows the SAME room state without
    # creating a second WebSocket or a duplicate member.
    duplicate = one.new_page()
    duplicate.on('pageerror', lambda err: errors.append(str(err)))
    duplicate.goto(ROOT)
    assert duplicate.locator('#home-device-label').inner_text() == 'Windows Laptop'
    duplicate.locator('#room-code-input').fill('HOME2026')
    duplicate.locator('#enter-room').click()
    duplicate.locator('#room-screen').wait_for(state='visible')
    assert duplicate.locator('#room-name').inner_text() == 'HOME2026'
    duplicate.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert duplicate.locator('#device-count').inner_text() == a.locator('#device-count').inner_text()
    assert duplicate.evaluate('window.__smokeWebSockets.length') == 0
    assert a.locator('#peer-list .device-row').count() == 1
    assert b.locator('#peer-list .device-row').count() == 1

    # Holding a room-specific lock must not block a DIFFERENT room in the
    # same browser profile.
    other = one.new_page()
    other.goto(ROOT)
    other.locator('#room-code-input').fill('OTHERCODE')
    other.locator('#enter-room').click()
    other.locator('#room-screen').wait_for(state='visible')
    other.locator('#leave-room').click()
    other.close()

    a.locator('#toggle-diagnostics').click()
    assert a.locator('#diagnostics-panel').is_visible()
    assert a.locator('#diagnostics-content').inner_text().strip()
    a.locator('#toggle-diagnostics').click()

    with a.expect_file_chooser() as chooser:
        a.locator('#drop-zone').click()
    chooser.value.set_files({'name': 'smoke.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
    assert a.locator('#sent-files .file-row').count() == 1
    assert 'smoke.txt' in a.locator('#sent-files').inner_text()
    duplicate.locator('#sent-files').get_by_text('smoke.txt').wait_for()
    assert duplicate.locator('#request-count').inner_text() == a.locator('#request-count').inner_text()

    # Mirror actions run in the first tab's P2P controller; source Files stay
    # in that original tab and both UI copies update together.
    with duplicate.expect_file_chooser() as mirror_chooser:
        duplicate.locator('#drop-zone').click()
    mirror_chooser.value.set_files({'name': 'mirror-shared.txt', 'mimeType': 'text/plain', 'buffer': b'mirror'})
    a.locator('#sent-files').get_by_text('mirror-shared.txt').wait_for()
    duplicate.locator('#sent-files').get_by_text('mirror-shared.txt').wait_for()
    duplicate.locator('#sent-files .file-row').filter(has_text='mirror-shared.txt').get_by_text('移除').click()
    a.locator('#sent-files').get_by_text('mirror-shared.txt').wait_for(state='detached')

    rename(duplicate, '#edit-device-name', '#my-device-label', 'Mirror Rename')
    a.wait_for_function("document.getElementById('my-device-label').textContent === 'Mirror Rename'")
    b.locator('#peer-list').get_by_text('Mirror Rename').wait_for()
    rename(a, '#edit-device-name', '#my-device-label', 'Updated Laptop')
    assert a.locator('#toast-message').inner_text() == '设备名称已修改'
    b.locator('#peer-list').get_by_text('Updated Laptop').wait_for()
    assert b.locator('#peer-list').get_by_text('Windows Laptop').count() == 0

    # Two genuinely independent browser profiles can intentionally have the
    # same editable name. The room must distinguish them in the peer list.
    rename(b, '#edit-device-name', '#my-device-label', 'Updated Laptop')
    a.wait_for_function("""() =>
        document.querySelector('#peer-list strong')?.textContent.startsWith('Updated Laptop · ')
    """)
    assert b.locator('#peer-list strong').inner_text().startswith('Updated Laptop · ')
    rename(b, '#edit-device-name', '#my-device-label', 'Mobile Phone')
    a.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert a.locator('#peer-list strong').inner_text() == 'Mobile Phone'

    # Leaving a mirror is tab-local and must not disconnect the owner or B.
    duplicate.locator('#leave-room').click()
    duplicate.locator('#home-screen').wait_for(state='visible')
    assert a.locator('#room-screen').is_visible()
    assert b.locator('#room-screen').is_visible()
    assert a.evaluate('window.__smokeWebSockets.length') == 1
    duplicate.locator('#enter-room').click()
    duplicate.locator('#room-screen').wait_for(state='visible')
    duplicate.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert duplicate.evaluate('window.__smokeWebSockets.length') == 0

    for page, name in ((a, 'desktop'), (b, 'mobile')):
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), name + ' horizontal overflow'
        page.screenshot(path=str(SCREENSHOT_DIR / (name + '-ui.png')), full_page=True)
    assert not errors, errors

    # R05 control-plane variant: B's socket closes unexpectedly, A stays
    # online, and B must automatically resume its *existing* room identity.
    # This same-machine test cannot assert B/C P2P path or file-byte recovery.
    b.locator('#toggle-diagnostics').click()
    assert b.evaluate('window.__smokeWebSockets.length') == 1
    b.evaluate('window.__smokeWebSockets[0].close(4000, "test interruption")')
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
    assert a.evaluate('window.__smokeWebSockets.length') == 1
    a.evaluate('window.__smokeWebSockets[0].close(4000, "test interruption")')
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
    # Leaving the primary room also closes its shared room views. A second
    # tab can then become the primary member without refreshing.
    duplicate.locator('#home-screen').wait_for(state='visible')
    duplicate.locator('#enter-room').click()
    duplicate.locator('#room-screen').wait_for(state='visible')
    assert duplicate.locator('#room-name').inner_text() == 'HOME2026'
    assert duplicate.evaluate('window.__smokeWebSockets.length') == 1
    duplicate.locator('#leave-room').click()
    browser.close()
    print('PASS: shared same-profile room view, mirrored share/withdraw/rename, duplicate names, R05/R06 recovery')
    print('LIMIT: same-host browsers and induced WebSocket close; no physical network outage, routed P2P or file-byte proof')
