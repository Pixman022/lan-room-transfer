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
    # A mirrored rename may be immediately overlaid by an older owner
    # snapshot; verify the settled rendered name, not a synchronous race.
    page.wait_for_function(
        '([selector, expected]) => document.querySelector(selector)?.textContent.trim() === expected',
        arg=[label, name], timeout=10000)


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
// Test-only partial receive: this validates browser lifecycle handoff,
// not actual transport of file bytes over a physical LAN.
window.__smokeStageInterruptedReceive = () => {
  const job = {
    peerId: 'disconnected-source', offerId: 'handoff-offer',
    fileId: 'handoff-file', name: 'handoff-partial.bin',
    size: 13, received: 5, chunks: [new Uint8Array([1, 2, 3, 4, 5])],
    status: '传输中', cancelled: false, url: null,
  };
  state.jobs.push(job);
  state.active = job;
  renderRoomFiles();
};
window.__smokeReceiveJobs = () => state.jobs.map(job => ({
  name: job.name, received: job.received, status: job.status,
  recovering: job.recovering === true, cancelled: job.cancelled === true,
}));
"""
        route.fulfill(response=response, body=response.body().decode('utf-8') + instrument)

    one.route('**/static/app.js', inject_file_state)
    two.route('**/static/app.js', inject_file_state)
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

    # New T04: three tabs from one Chrome profile share one device's file shelf.
    # A holds the transport; closing B/C must NOT withdraw any shared file.
    sibling = one.new_page()
    sibling.on('pageerror', lambda err: errors.append(str(err)))
    sibling.goto(ROOT)
    sibling.locator('#room-code-input').fill('HOME2026')
    sibling.locator('#enter-room').click()
    sibling.locator('#room-screen').wait_for(state='visible')
    assert sibling.evaluate('window.__smokeWebSockets.length') == 0
    with sibling.expect_file_chooser() as sibling_chooser:
        sibling.locator('#drop-zone').click()
    sibling_chooser.value.set_files({
        'name':'third-tab-kept.txt', 'mimeType':'text/plain', 'buffer':b'c-survives',
    })
    a.locator('#sent-files').get_by_text('third-tab-kept.txt').wait_for()

    # Closing follower B must keep its File in the one logical device's shelf.
    with duplicate.expect_file_chooser() as local_chooser:
        duplicate.locator('#drop-zone').click()
    local_chooser.value.set_files({
        'name':'mirror-exit.txt', 'mimeType':'text/plain', 'buffer':b'local-follower',
    })
    a.locator('#sent-files').get_by_text('mirror-exit.txt').wait_for()
    # Browser close cannot revoke a share already replicated to the owner.
    duplicate.close()
    a.locator('#sent-files').get_by_text('mirror-exit.txt').wait_for()
    a.locator('#sent-files').get_by_text('smoke.txt').wait_for()
    a.locator('#sent-files').get_by_text('third-tab-kept.txt').wait_for()
    # Cross the old 4-second follower-source liveness poll boundary: old
    # behavior reaped B's file even if its pagehide notice was discarded.
    a.wait_for_timeout(5500)
    a.locator('#sent-files').get_by_text('mirror-exit.txt').wait_for()
    assert [row['bytes'] for row in a.evaluate('window.__smokeOwnFileData()')] == [
        list(b'hello'), list(b'c-survives'), list(b'local-follower'),
    ]
    assert sibling.locator('#room-screen').is_visible()
    assert a.locator('#room-screen').is_visible()
    assert b.locator('#room-screen').is_visible()
    assert a.evaluate('window.__smokeWebSockets.length') == 1
    assert sibling.evaluate('window.__smokeWebSockets.length') == 0
    sibling.close()
    a.locator('#sent-files').get_by_text('third-tab-kept.txt').wait_for()
    a.locator('#sent-files').get_by_text('mirror-exit.txt').wait_for()
    duplicate = one.new_page()
    duplicate.on('pageerror', lambda err: errors.append(str(err)))
    duplicate.goto(ROOT)
    duplicate.locator('#room-code-input').fill('HOME2026')
    duplicate.locator('#enter-room').click()
    duplicate.locator('#room-screen').wait_for(state='visible')
    duplicate.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert duplicate.evaluate('window.__smokeWebSockets.length') == 0
    # File picked in the surviving tab belongs to that tab, even while the
    # original transport tab owns the one P2P connection.
    with duplicate.expect_file_chooser() as keep_chooser:
        duplicate.locator('#drop-zone').click()
    keep_chooser.value.set_files({
        'name':'mirror-stay.txt', 'mimeType':'text/plain', 'buffer':b'keep-mirror',
    })
    a.locator('#sent-files').get_by_text('mirror-stay.txt').wait_for()

    for page, name in ((a, 'desktop'), (b, 'mobile')):
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), name + ' horizontal overflow'
        page.screenshot(path=str(SCREENSHOT_DIR / (name + '-ui.png')), full_page=True)
    assert not errors, errors

    # R05 control-plane variant: B's socket closes unexpectedly, A stays
    # online, and B must automatically resume its *existing* room identity.
    # This same-machine test cannot assert B/C P2P path or file-byte recovery.
    b.locator('#toggle-diagnostics').click()
    assert b.evaluate('window.__smokeWebSockets.length') == 1
    # A real Chromium WebSocket can close while this tab owns an unfinished
    # receive. Preserve its intent instead of permanently failing it.
    b.evaluate('window.__smokeStageInterruptedReceive()')
    assert b.evaluate('window.__smokeReceiveJobs()[0].received') == 5
    b.evaluate('window.__smokeWebSockets[0].close(4000, "test interruption")')
    b.wait_for_function("""() =>
        window.__smokeWebSockets.length >= 2 &&
        window.__smokeWebSockets.at(-1).readyState === WebSocket.OPEN &&
        document.getElementById('diagnostics-content').textContent.includes('房间进入：resumed')
    """, timeout=15000)
    b.locator('#peer-list').get_by_text('Updated Laptop').wait_for()
    assert b.locator('#room-name').inner_text() == 'HOME2026'
    b.wait_for_function("""() => {
      const job=window.__smokeReceiveJobs().find(item => item.name==='handoff-partial.bin');
      return job && job.recovering && job.received === 0 &&
        job.status === '等待连接恢复后重新接收';
    }""", timeout=15000)
    b.locator('#incoming-requests').get_by_text('handoff-partial.bin').wait_for()
    assert b.locator('#incoming-requests').get_by_role('button', name='取消').count() == 1
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
    assert a.locator('#sent-files .file-row').count() == 4
    assert 'smoke.txt' in a.locator('#sent-files').inner_text()
    assert 'mirror-exit.txt' in a.locator('#sent-files').inner_text()
    assert 'third-tab-kept.txt' in a.locator('#sent-files').inner_text()
    assert 'mirror-stay.txt' in a.locator('#sent-files').inner_text()
    a.locator('#toggle-diagnostics').click()
    assert not errors, errors

    # The remote sending device must remain in the room during takeover;
    # otherwise the original room would be empty/closed and a fresh room
    # correctly cannot resume an absent source (covered by Node regression).
    b.locator('#room-code-input').fill('HOME2026')
    b.locator('#enter-room').click()
    b.locator('#room-screen').wait_for(state='visible')
    a.locator('#peer-list').get_by_text('Mobile Phone').wait_for()

    # The outgoing transport tab may close while bytes are still buffered.
    # Do not wait for the coalesced 120 ms room snapshot: pagehide must hand
    # off the latest receive intent so the survivor can restart from zero.
    a.evaluate('window.__smokeStageInterruptedReceive()')
    assert a.evaluate('window.__smokeReceiveJobs()[0].received') == 5
    a.close()
    # Closing (not explicitly leaving) the owner tab causes takeover. Only
    # files selected by that closed tab are withdrawn.
    duplicate.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert duplicate.locator('#room-name').inner_text() == 'HOME2026'
    duplicate.wait_for_function("""() => {
      const job = window.__smokeReceiveJobs().find(item => item.name === 'handoff-partial.bin');
      return job && job.recovering && job.received === 0 &&
        job.status === '等待连接恢复后重新接收';
    }""", timeout=15000)
    duplicate.locator('#incoming-requests').get_by_text('handoff-partial.bin').wait_for()
    assert duplicate.locator('#incoming-requests').get_by_role('button', name='取消').count() == 1
    duplicate.locator('#sent-files').get_by_text('smoke.txt').wait_for()
    duplicate.locator('#sent-files').get_by_text('third-tab-kept.txt').wait_for()
    duplicate.locator('#sent-files').get_by_text('mirror-exit.txt').wait_for()
    duplicate.locator('#sent-files').get_by_text('mirror-stay.txt').wait_for()
    assert [row['bytes'] for row in duplicate.evaluate('window.__smokeOwnFileData()')] == [
        list(b'hello'), list(b'c-survives'), list(b'local-follower'), list(b'keep-mirror'),
    ], 'transport takeover must preserve EVERY original tab share as a usable File'
    duplicate.locator('#peer-list').get_by_text('Mobile Phone').wait_for()
    assert duplicate.locator('#connection-status').inner_text() in (
        '直连未就绪', '文件直连就绪',
    ), 'real remote member stays in the room after owner-tab closure'
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
    with survivor.expect_file_chooser() as survivor_chooser:
        survivor.locator('#drop-zone').click()
    survivor_chooser.value.set_files({
        'name':'survivor-owned.bin', 'mimeType':'application/octet-stream',
        'buffer':b'from-second-tab',
    })
    with third.expect_file_chooser() as third_chooser:
        third.locator('#drop-zone').click()
    third_chooser.value.set_files({
        'name':'third-owned.bin', 'mimeType':'application/octet-stream',
        'buffer':b'from-third-tab',
    })
    survivor.locator('#sent-files').get_by_text('third-owned.bin').wait_for()
    third.locator('#sent-files').get_by_text('survivor-owned.bin').wait_for()

    abrupt.close()
    survivor.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert survivor.locator('#room-name').inner_text() == 'ABRUPT26'
    survivor.locator('#sent-files').get_by_text('survive-owner-close.bin').wait_for(state='detached')
    survivor.locator('#sent-files').get_by_text('survivor-owned.bin').wait_for()
    survivor.locator('#sent-files').get_by_text('third-owned.bin').wait_for()
    assert [row['bytes'] for row in survivor.evaluate('window.__smokeOwnFileData()')] == [
        list(b'from-second-tab'), list(b'from-third-tab')
    ], 'file selected by a surviving tab was lost'
    assert '房间同步中断' not in survivor.locator('#feedback').inner_text()
    assert third.evaluate('window.__smokeWebSockets.length') == 0
    third.locator('#sent-files').get_by_text('survive-owner-close.bin').wait_for(state='detached')

    # When the second tab closes, its own file disappears but the third
    # tab's independently selected file remains available.
    survivor.close()
    third.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN &&
        document.getElementById('room-screen').hidden === false
    """, timeout=15000)
    assert third.locator('#room-name').inner_text() == 'ABRUPT26'
    third.locator('#sent-files').get_by_text('survivor-owned.bin').wait_for(state='detached')
    third.locator('#sent-files').get_by_text('third-owned.bin').wait_for()
    assert [row['bytes'] for row in third.evaluate('window.__smokeOwnFileData()')] == [list(b'from-third-tab')], 'third tab lost its own file'
    third.locator('#leave-room').click()
    third.locator('#home-screen').wait_for(state='visible')

    # A newly shared file disappears when its selecting tab closes,
    # even before the next coalesced UI snapshot is emitted.
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
    with quick_follower.expect_file_chooser() as keep_chooser:
        quick_follower.locator('#drop-zone').click()
    keep_chooser.value.set_files({
        'name':'still-open.txt', 'mimeType':'text/plain', 'buffer':b'still-open',
    })
    quick.locator('#sent-files').get_by_text('still-open.txt').wait_for()
    with quick.expect_file_chooser() as chooser:
        quick.locator('#drop-zone').click()
    chooser.value.set_files({
        'name':'fast-exit.txt', 'mimeType':'text/plain', 'buffer':b'content-survives',
    })
    # Intentionally DO NOT wait for the follower's file shelf to update.
    quick.close()
    quick_follower.wait_for_function("""() =>
        window.__smokeWebSockets.length === 1 &&
        window.__smokeWebSockets[0].readyState === WebSocket.OPEN
    """, timeout=15000)
    quick_follower.locator('#sent-files').get_by_text('fast-exit.txt').wait_for(state='detached')
    quick_follower.locator('#sent-files').get_by_text('still-open.txt').wait_for()
    assert [row['bytes'] for row in quick_follower.evaluate('window.__smokeOwnFileData()')] == [list(b'still-open')], 'surviving tab lost its independently selected file'
    quick_follower.locator('#leave-room').click()

    # Deliberate "退出房间" is different from closing a tab: clicking it in
    # ANY same-profile view exits all tabs for this room, while a member in an
    # independent browser profile remains in the room.
    group_a = one.new_page()
    group_b = one.new_page()
    group_c = one.new_page()
    outside = two.new_page()
    for page in (group_a, group_b, group_c, outside):
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto(ROOT)
        page.locator('#room-code-input').fill('QUITALL1')
        page.locator('#enter-room').click()
        page.locator('#room-screen').wait_for(state='visible')
    outside.locator('#peer-list .device-row').wait_for(state='visible')
    assert outside.locator('#peer-list .device-row').count() == 1
    assert group_b.evaluate('window.__smokeWebSockets.length') == 0
    assert group_c.evaluate('window.__smokeWebSockets.length') == 0

    # B is only a mirrored room view. Its explicit Leave must close A/B/C.
    group_b.locator('#leave-room').click()
    for page in (group_a, group_b, group_c):
        page.locator('#home-screen').wait_for(state='visible')
    outside.locator('#peer-list .device-row').wait_for(state='hidden')
    assert outside.locator('#room-screen').is_visible()
    assert group_c.evaluate('window.__smokeWebSockets.length') == 0

    # The user may explicitly join the same code again after group exit;
    # a stale exit revision must not prevent a fresh user-requested join.
    for page in (group_a, group_b, group_c):
        page.locator('#room-code-input').fill('QUITALL1')
        page.locator('#enter-room').click()
        page.locator('#room-screen').wait_for(state='visible')
    outside.locator('#peer-list .device-row').wait_for(state='visible')
    assert outside.locator('#peer-list .device-row').count() == 1

    # A holds the actual WebSocket this time; its explicit Leave still ends
    # the entire group, not merely the transport-owning tab.
    group_a.locator('#leave-room').click()
    for page in (group_a, group_b, group_c):
        page.locator('#home-screen').wait_for(state='visible')
    outside.locator('#peer-list .device-row').wait_for(state='hidden')
    assert outside.locator('#room-screen').is_visible()
    outside.locator('#leave-room').click()
    for page in (group_a, group_b, group_c, outside):
        page.close()
    assert not errors, errors
    browser.close()
    print('PASS: explicit Leave exits all same-profile room tabs; closing a tab preserves survivors, R05/R06')
    print('LIMIT: same-host browsers and induced WebSocket close; no physical network outage, routed P2P or file-byte proof')
