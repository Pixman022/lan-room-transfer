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
    # Instrument the local test response only; production app.js exposes no
    # File bytes, credentials, or debugging state to global window.
    def inject_file_state(route):
        response = route.fetch()
        instrument = """
window.__smokeOwnFileData = async () => {
  const rows = [];
  for (const [offerId, files] of state.outbound) {
    for (const [fileId, file] of files) {
      rows.push({offerId, fileId, size:file.size,
        bytes:[...new Uint8Array(await file.arrayBuffer())]});
    }
  }
  return rows;
};
window.__smokeMirrorFileData = async () => {
  const rows = [];
  for (const [offerId, files] of mirroredRoom?.sources ?? []) {
    for (const [fileId, file] of files) {
      rows.push({offerId, fileId, size:file.size,
        bytes:[...new Uint8Array(await file.arrayBuffer())]});
    }
  }
  return rows;
};
"""
        route.fulfill(response=response, body=response.body().decode('utf-8') + instrument)

    one.route('**/static/app.js', inject_file_state)
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

    # A mirrored tab reload keeps the room-code prefill, then resumes the
    # shared view without making its own connection.
    duplicate.reload()
    assert duplicate.locator('#room-code-input').input_value() == 'HOME2026'
    duplicate.locator('#enter-room').click()
    duplicate.locator('#room-screen').wait_for(state='visible')
    duplicate.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert duplicate.evaluate('window.__smokeWebSockets.length') == 0

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
    assert [row['bytes'] for row in a.evaluate('window.__smokeOwnFileData()')] == [[104, 101, 108, 108, 111]]
    duplicate.wait_for_function("""async () => {
      const files = await window.__smokeMirrorFileData();
      return files.length === 1 && files[0].size === 5;
    }""")
    assert [row['bytes'] for row in duplicate.evaluate('window.__smokeMirrorFileData()')] == [[104, 101, 108, 108, 111]]

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
    # The owner may leave without ejecting its other same-room tabs. The
    # surviving tab automatically takes the exclusive lock, reconnects with
    # the same room code and keeps its shared File object available.
    duplicate.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert duplicate.locator('#room-name').inner_text() == 'HOME2026'
    assert 'smoke.txt' in duplicate.locator('#sent-files').inner_text()
    assert [row['bytes'] for row in duplicate.evaluate('window.__smokeOwnFileData()')] == [[104, 101, 108, 108, 111]], 'source File disappeared after explicit owner Exit'
    assert duplicate.locator('#connection-status').inner_text() == '房间已连接'
    duplicate.locator('#leave-room').click()
    duplicate.locator('#home-screen').wait_for(state='visible')

    # Abruptly closing the transport-holding tab must also trigger automatic
    # election, without requiring a click/refresh in its surviving tab.
    abrupt = one.new_page()
    abrupt.goto(ROOT)
    abrupt.locator('#room-code-input').fill('ABRUPT26')
    abrupt.locator('#enter-room').click()
    abrupt.locator('#room-screen').wait_for(state='visible')
    with abrupt.expect_file_chooser() as abrupt_chooser:
        abrupt.locator('#drop-zone').click()
    abrupt_chooser.value.set_files({
        'name': 'survive-owner-close.bin', 'mimeType': 'application/octet-stream',
        'buffer': b'test-handoff-bytes',
    })
    survivor = one.new_page()
    survivor.goto(ROOT)
    survivor.locator('#room-code-input').fill('ABRUPT26')
    survivor.locator('#enter-room').click()
    survivor.locator('#room-screen').wait_for(state='visible')
    survivor.locator('#sent-files').get_by_text('survive-owner-close.bin').wait_for()
    assert survivor.evaluate('window.__smokeWebSockets.length') == 0
    survivor.wait_for_function("""async () => {
      const files = await window.__smokeMirrorFileData();
      return files.length === 1 && files[0].size === 18;
    }""")
    third = one.new_page()
    third.goto(ROOT)
    third.locator('#room-code-input').fill('ABRUPT26')
    third.locator('#enter-room').click()
    third.locator('#room-screen').wait_for(state='visible')
    third.locator('#sent-files').get_by_text('survive-owner-close.bin').wait_for()
    assert third.evaluate('window.__smokeWebSockets.length') == 0

    abrupt.close()
    survivor.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert survivor.locator('#room-name').inner_text() == 'ABRUPT26'
    assert survivor.locator('#sent-files').get_by_text('survive-owner-close.bin').is_visible()
    assert [row['bytes'] for row in survivor.evaluate('window.__smokeOwnFileData()')] == [list(b'test-handoff-bytes')], 'source File disappeared on owner tab close'
    assert '房间同步中断' not in survivor.locator('#feedback').inner_text()
    assert third.evaluate('window.__smokeWebSockets.length') == 0
    third.locator('#sent-files').get_by_text('survive-owner-close.bin').wait_for()

    # With three same-room tabs, the final surviving tab must also take over
    # the same room and its staged File after the second owner disappears.
    survivor.close()
    third.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert third.locator('#room-name').inner_text() == 'ABRUPT26'
    assert third.locator('#sent-files').get_by_text('survive-owner-close.bin').is_visible()
    assert [row['bytes'] for row in third.evaluate('window.__smokeOwnFileData()')] == [list(b'test-handoff-bytes')], 'source File disappeared after second owner tab close'
    third.locator('#leave-room').click()
    third.locator('#home-screen').wait_for(state='visible')

    # Regression for real field report: user shares a file and immediately
    # exits the transport tab, before the 120-ms coalesced UI snapshot fires.
    # The handoff message must include source AND file-list metadata together.
    quick = one.new_page()
    quick.goto(ROOT)
    quick.locator('#room-code-input').fill('FASTEXIT')
    quick.locator('#enter-room').click()
    quick.locator('#room-screen').wait_for(state='visible')
    quick_follower = one.new_page()
    quick_follower.goto(ROOT)
    quick_follower.locator('#room-code-input').fill('FASTEXIT')
    quick_follower.locator('#enter-room').click()
    quick_follower.locator('#room-screen').wait_for(state='visible')
    assert quick_follower.evaluate('window.__smokeWebSockets.length') == 0
    with quick.expect_file_chooser() as chooser:
        quick.locator('#drop-zone').click()
    chooser.value.set_files({
        'name':'fast-exit.txt', 'mimeType':'text/plain', 'buffer':b'content-survives',
    })
    # Intentionally DO NOT wait for the follower's file shelf to update.
    quick.locator('#leave-room').click()
    quick_follower.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN
    """, timeout=15000)
    quick_follower.locator('#sent-files').get_by_text('fast-exit.txt').wait_for()
    assert [row['bytes'] for row in quick_follower.evaluate('window.__smokeOwnFileData()')] == [list(b'content-survives')], 'rapid Leave dropped shared file bytes'
    quick_follower.locator('#leave-room').click()
    browser.close()
    print('PASS: source File bytes survive rapid Leave and multi-tab handoff, R05/R06')
    print('LIMIT: same-host browsers and induced WebSocket close; no physical network outage, routed P2P or file-byte proof')
