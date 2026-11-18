"""Offline DOM interaction test. No WebRTC connectivity or file-byte transfer is simulated."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
modules = ['device-name.js', 'room-code.js', 'route-policy.js']
code = '\n'.join(re.sub(r'\bexport (?=(?:const|function|async function)\b)', '', (ROOT / 'public' / module).read_text())
                 for module in modules)
app = '\n'.join(line for line in (ROOT / 'public/app.js').read_text().splitlines()
                if not line.startswith('import '))
code += '\n' + app + '\nwindow.__demo = {state, showRoom, renderPeers, renderRequests, renderJobs};'
html = (ROOT / 'public/index.html').read_text()
css = (ROOT / 'public/styles.css').read_text()
html = html.replace('<link rel="stylesheet" href="/static/styles.css" />', '<style>' + css + '</style>')
html = html.replace('<script type="module" src="/static/app.js"></script>', '')
html = html.replace('</body>', '<script>\n' +
                    'window.__messages = [];\n' +
                    'if (!crypto.randomUUID) crypto.randomUUID = () => "test-" + Math.random();\n' + code + '\n</script></body>')

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for width, height, label in [(1300, 900, 'desktop'), (390, 844, 'mobile')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        page.set_content(html)
        assert re.fullmatch(r'\d{4}', page.locator('#room-code-input').input_value())
        assert re.fullmatch(r'[A-Z][a-z]+ [A-Z][a-z]+', page.locator('#device-name').input_value())
        assert page.locator('#send-target').count() == 0
        assert page.locator('#send-offer').count() == 0
        page.locator('#device-name').fill('Coral Fox')
        assert page.locator('#home-device-avatar').inner_text() == '🦊'
        page.locator('#room-code-input').fill('HOME2026')
        page.screenshot(path=str(ROOT / 'docs' / f'{label}-static.png'), full_page=True)

        page.evaluate('''() => {
            const d = window.__demo;
            d.state.code = 'HOME2026';
            d.showRoom(true);
            document.getElementById('room-name').textContent = 'HOME2026';
            document.getElementById('my-device-label').textContent = 'Coral Fox';
            d.state.peers.set('peer-1', {id:'peer-1', name:'Amber Bear', ready:true,
                reason:'连接已就绪', sending:new Map(), channel:{readyState:'open',
                    send: data => window.__messages.push(JSON.parse(data))}});
            d.state.peers.set('peer-2', {id:'peer-2', name:'Silver Otter', ready:false,
                reason:'正在检查连接', sending:new Map()});
            d.renderPeers();
        }''')
        assert page.locator('#peer-list .device-row button').count() == 2
        assert page.locator('#peer-list .device-row button').first.is_enabled()
        assert page.locator('#peer-list .device-row button').nth(1).is_disabled()
        assert page.locator('#drop-target').inner_text() == '发送给 Amber Bear'
        assert page.locator('#peer-list .device-icon').first.inner_text() == '🐻'
        assert page.locator('#name-editor-panel').is_hidden()
        page.locator('#edit-device-name').click()
        assert page.locator('#name-editor-panel').is_visible()
        page.locator('#room-device-name').fill('Peach Panda')
        page.locator('#save-device-name').click()
        assert page.locator('#name-editor-panel').is_hidden()
        assert page.locator('#my-device-label').inner_text() == 'Peach Panda'
        assert page.locator('#my-device-avatar').inner_text() == '🐼'
        with page.expect_file_chooser() as chooser:
            page.locator('#peer-list .device-row button').first.click()
        chooser.value.set_files({'name':'example.txt', 'mimeType':'text/plain', 'buffer':b'hello'})
        assert page.evaluate('window.__messages.length') == 1, 'file offer must send immediately after choosing'
        assert page.evaluate('window.__messages[0].kind') == 'file-list'
        assert page.evaluate('window.__messages[0].files[0].name') == 'example.txt'
        assert page.locator('#sent-files .file-row').count() == 1

        with page.expect_file_chooser() as chooser:
            page.locator('#drop-zone').click()
        chooser.value.set_files({'name':'selected.txt', 'mimeType':'text/plain', 'buffer':b'abc'})
        assert page.evaluate('window.__messages.length') == 2
        assert page.evaluate('window.__messages[1].files[0].name') == 'selected.txt'

        page.evaluate('''() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(['dropped'], 'dropped.txt', {type:'text/plain'}));
            document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', {
                bubbles:true, cancelable:true, dataTransfer:transfer,
            }));
        }''')
        assert page.evaluate('window.__messages.length') == 3
        assert page.evaluate('window.__messages[2].files[0].name') == 'dropped.txt'

        page.evaluate('''() => {
            const d = window.__demo;
            d.state.offers.set('peer-1:received', {peerId:'peer-1', offerId:'received', files:[
                {id:'file-a', name:'Design.pdf', size:278312, status:'pending'},
                {id:'file-b', name:'Photo.png', size:92345, status:'pending'}
            ]});
            d.renderRequests();
        }''')
        assert page.locator('.request .file-row button').count() == 2
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-static.png'), full_page=True)
        assert page.locator('.request-footer button').inner_text() == '接收全部 (2)'
        page.locator('.request .file-row button').first.click()
        assert page.evaluate('window.__demo.state.jobs.length') == 1
        page.locator('.request-footer button').click()
        assert page.evaluate('window.__demo.state.jobs.length') == 2
        assert page.evaluate('window.__demo.state.queue.length') == 1, 'receiver must queue second file'
        assert page.locator('.request input[type=checkbox]').count() == 0
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-queue-static.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'{label} horizontal overflow'
        assert not errors, errors
        print(f'PASS: {label} room actions, file-picker auto-offer, receive controls, queue, rename, no overflow')
        page.close()
    browser.close()
