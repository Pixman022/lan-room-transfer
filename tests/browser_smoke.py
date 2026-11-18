"""Non-production UI smoke test. Runs with local Chromium/Playwright."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = os.getenv('LAN_ROOM_TEST_URL', 'http://127.0.0.1:8765')
BINARY = os.getenv('CHROMIUM_BINARY')
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, **({'executable_path': BINARY} if BINARY else {}))
    one = browser.new_context(viewport={'width': 1280, 'height': 900})
    two = browser.new_context(viewport={'width': 390, 'height': 844})
    a, b = one.new_page(), two.new_page()
    errors = []
    for page in (a, b):
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.goto(ROOT)
    initial = a.locator('#device-name').input_value()
    assert initial and initial != 'My device'
    a.locator('#room-code-input').wait_for()
    assert len(a.locator('#room-code-input').input_value()) == 4
    assert a.locator('#room-code-input').input_value().isdigit()
    a.reload()
    assert a.locator('#device-name').input_value() == initial, 'random device name not persisted'
    a.locator('#device-name').fill('Windows 笔记本')
    a.locator('#room-code-input').fill('home2026')
    a.locator('#enter-room').click()
    a.locator('#room-name').wait_for()
    assert a.locator('#room-name').inner_text() == 'HOME2026'
    b.locator('#device-name').fill('我的手机')
    b.locator('#room-code-input').fill('HOME2026')
    b.locator('#enter-room').click()
    b.locator('#room-name').wait_for()
    a.locator('#peer-list').get_by_text('我的手机').wait_for()
    b.locator('#peer-list').get_by_text('Windows 笔记本').wait_for()
    assert a.locator('#peer-list').get_by_text('我的手机').count() == 1
    assert b.locator('#peer-list').get_by_text('Windows 笔记本').count() == 1
    assert a.locator('#send-target').count() == 0
    assert a.locator('#send-offer').count() == 0
    assert a.locator('#peer-list .device-row').count() == 1
    assert a.locator('#peer-list .device-row button').count() == 0
    assert a.locator('#connection-status').inner_text() == '直连未就绪', 'same-host route must remain blocked'
    a.locator('#toggle-diagnostics').click()
    assert a.locator('#diagnostics-panel').is_visible()
    assert a.locator('#diagnostics-content .diagnostic-line').count() == 2
    a.locator('#toggle-diagnostics').click()
    with a.expect_file_chooser() as chooser:
        a.locator('#drop-zone').click()
    chooser.value.set_files({'name': 'smoke.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
    assert a.locator('#sent-files .file-row').count() == 1
    assert '等待设备直连' in a.locator('#sent-files .file-row').inner_text(), 'same-host route still blocked'
    assert a.locator('#name-editor-panel').is_hidden()
    assert a.locator('#my-device-label').inner_text() == 'Windows 笔记本'
    a.locator('#edit-device-name').click()
    a.locator('#room-device-name').fill('Updated-Laptop')
    a.locator('#save-device-name').click()
    assert a.locator('#name-editor-panel').is_hidden()
    assert a.locator('#my-device-label').inner_text() == 'Updated-Laptop'
    b.locator('#peer-list').get_by_text('Updated-Laptop').wait_for()
    assert b.locator('#peer-list').get_by_text('Windows \u7b14\u8bb0\u672c').count() == 0
    a.screenshot(path=str(Path(__file__).resolve().parents[1] / 'docs/desktop-ui.png'), full_page=True)
    b.screenshot(path=str(Path(__file__).resolve().parents[1] / 'docs/mobile-ui.png'), full_page=True)
    assert not errors, errors
    print('PASS: room entry, presence, unverified-route status, diagnostic panel, file staging, rename, responsive UI, no JS errors')
    print('NOTE: no file bytes tested; same-host loopback is intentionally rejected by route policy')
    b.locator('#leave-room').click()
    b.locator('#home-screen').wait_for(state='visible')
    assert a.locator('#peer-list').get_by_text('我的手机').count() == 0
    a.locator('#leave-room').click()
    a.locator('#home-screen').wait_for(state='visible')
    browser.close()
