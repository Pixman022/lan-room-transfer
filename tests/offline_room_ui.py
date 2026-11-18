"""Offline DOM test for room-wide ephemeral file sharing (no real WebRTC)."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
modules = ['device-name.js', 'room-code.js', 'route-policy.js']
code = '\n'.join(re.sub(r'\bexport (?=(?:const|function|async function)\b)', '', (ROOT / 'public' / module).read_text())
                 for module in modules)
app = '\n'.join(line for line in (ROOT / 'public/app.js').read_text().splitlines()
                if not line.startswith('import '))
code += '\n' + app + '\nwindow.__demo = {state, showRoom, renderPeers, renderRequests, renderJobs, '
code += 'syncSharedOffers, receiveChannel, handleServer, shareFiles, withdrawSharedFile};'
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
            d.renderPeers();
        }''')
        assert page.locator('#peer-list .device-row').count() == 0
        assert page.locator('#drop-target').count() == 0
        assert page.locator('#peer-list button').count() == 0
        # A file can be shared before another device arrives.
        with page.expect_file_chooser() as chooser:
            page.locator('#drop-zone').click()
        chooser.value.set_files({'name': 'first.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
        assert page.evaluate('window.__demo.state.ownOffers.length') == 1
        assert page.evaluate('window.__messages.length') == 0
        assert page.locator('#sent-files .file-row').count() == 1
        assert page.locator('#sent-files .file-row button').inner_text() == '移除'

        # Verify all ready devices get the existing catalog, but unready ones do not.
        page.evaluate('''() => {
            const d = window.__demo;
            for (const [id, name, ready] of [['peer-1','Amber Bear',true],
                                             ['peer-2','Silver Otter',true],
                                             ['peer-3','Sky Owl',false]]) {
                const peer = {id, name, ready, reason:'等待局域网连接',
                    sending:new Map(), syncedOffers:new Set(), pc:{close(){}},
                    channel:{readyState:'open', send: data =>
                        window.__messages.push({id, packet:JSON.parse(data)})}};
                d.state.peers.set(id, peer);
                d.syncSharedOffers(peer);
            }
            d.renderPeers();
        }''')
        assert page.evaluate('window.__messages.length') == 2
        assert page.evaluate('window.__messages.every(m => m.packet.kind === "file-list")')
        assert page.locator('#peer-list .device-row').count() == 3
        assert page.locator('#peer-list button').count() == 0
        assert page.locator('#peer-list .device-icon').first.inner_text() == '🐻'
        assert page.locator('#name-editor-panel').is_hidden()
        page.locator('#edit-device-name').click()
        page.locator('#room-device-name').fill('Peach Panda')
        page.locator('#save-device-name').click()
        assert page.locator('#my-device-label').inner_text() == 'Peach Panda'
        assert page.locator('#my-device-avatar').inner_text() == '🐼'

        # New uploads are announced to *all* connected devices, without a recipient selector.
        page.evaluate('''() => {
            const transfer = new DataTransfer();
            transfer.items.add(new File(['dropped'], 'second.txt', {type:'text/plain'}));
            document.getElementById('drop-zone').dispatchEvent(new DragEvent('drop', {
                bubbles:true, cancelable:true, dataTransfer:transfer,
            }));
        }''')
        assert page.evaluate('window.__messages.length') == 4
        assert page.evaluate('window.__messages.slice(2).every(m => m.packet.files[0].name === "second.txt")')
        assert page.locator('#sent-files .file-row').count() == 2
        # A later arriving verified device sees both batches, via P2P metadata sync.
        page.evaluate('''() => {
            const d = window.__demo;
            const id = 'peer-4';
            const peer = {id, name:'Violet Wolf', ready:true, syncedOffers:new Set(),
                sending:new Map(), pc:{close(){}}, channel:{readyState:'open', send: data =>
                window.__messages.push({id, packet:JSON.parse(data)})}};
            d.state.peers.set(id, peer); d.syncSharedOffers(peer); d.renderPeers();
        }''')
        assert page.evaluate('window.__messages.length') == 6
        assert page.evaluate('window.__messages.slice(-2).every(m => m.id === "peer-4")')

        # Incoming room-wide file lists keep the individual / receive-all queue UX.
        page.evaluate('''async () => {
            const d = window.__demo;
            await d.receiveChannel(d.state.peers.get('peer-1'), JSON.stringify({
                kind:'file-list', offerId:'received', files:[
                    {id:'file-a', name:'Design.pdf', size:278312},
                    {id:'file-b', name:'Photo.png', size:92345}
                ]}));
        }''')
        assert page.locator('.request .file-row button').count() == 2
        assert page.locator('.request-footer button').inner_text() == '接收全部 (2)'
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-static.png'), full_page=True)
        page.locator('.request .file-row button').first.click()
        assert page.evaluate('window.__demo.state.jobs.length') == 1
        page.locator('.request-footer button').click()
        assert page.evaluate('window.__demo.state.jobs.length') == 2
        assert page.evaluate('window.__demo.state.queue.length') == 1
        assert page.locator('.request input[type=checkbox]').count() == 0

        # Withdrawal propagates to every connected device without affecting other files.
        page.locator('#sent-files .file-row button').first.click()
        assert page.locator('#sent-files .file-row').count() == 1
        assert page.evaluate('window.__messages.filter(m => m.packet.kind === "file-withdraw").length') == 3
        # Files shared by disconnected uploader disappear, rather than implying cloud storage.
        page.evaluate('''async () => {
            const d = window.__demo;
            await d.handleServer({type:'peer-offline', id:'peer-1'});
        }''')
        assert page.locator('#incoming-requests .request').count() == 0
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-queue-static.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'{label} horizontal overflow'
        assert not errors, errors
        print(f'PASS: {label} room broadcast, late join sync, withdrawal, receive queue, rename, no overflow')
        page.close()
    browser.close()
