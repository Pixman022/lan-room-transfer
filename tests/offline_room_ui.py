"""Offline DOM test for room-wide ephemeral file sharing (no real WebRTC)."""
from pathlib import Path
import os
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
modules = ['device-name.js', 'room-code.js', 'route-policy.js', 'checksum.js']
code = '\n'.join(re.sub(r'\bexport (?=(?:const|function|async function)\b)', '', (ROOT / 'public' / module).read_text())
                 for module in modules)
app = '\n'.join(line for line in (ROOT / 'public/app.js').read_text().splitlines()
                if not line.startswith('import '))
code += '\n' + app + '\nwindow.__demo = {state, showRoom, renderPeers, renderRoomFiles, '
code += 'syncSharedOffers, receiveChannel, handleServer, shareFiles, withdrawSharedFile, orderedMessageHandler, createPeer};'
html = (ROOT / 'public/index.html').read_text()
css = (ROOT / 'public/styles.css').read_text()
html = html.replace('<link rel="stylesheet" href="/static/styles.css" />', '<style>' + css + '</style>')
html = html.replace('<script type="module" src="/static/app.js"></script>', '')
html = html.replace('</body>', '<script>\n' +
                    'window.__messages = [];\n' +
                    'if (!crypto.randomUUID) crypto.randomUUID = () => "test-" + Math.random();\n' + code + '\n</script></body>')

with sync_playwright() as playwright:
    binary = os.getenv('CHROMIUM_BINARY')
    options = {'headless': True}
    if binary:
        options['executable_path'] = binary
    browser = playwright.chromium.launch(**options)
    for width, height, label in [(1300, 900, 'desktop'), (390, 844, 'mobile')]:
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        page.set_content(html)
        # Pairing page hierarchy: avatar, editable device name, small badge, original room-code editor.
        assert page.evaluate('''() => [...document.querySelector('.entry-panel').children]
            .map(node => node.className).join('|')''') == (
                'entry-avatar|entry-device|entry-room-code|primary wide')
        avatar = page.locator('.entry-avatar').bounding_box()
        name = page.locator('.entry-device .device-name-line').bounding_box()
        chip = page.locator('.entry-device-chip').bounding_box()
        code = page.locator('.entry-room-code').bounding_box()
        enter = page.locator('#enter-room').bounding_box()
        assert avatar and name and chip and code and enter
        assert avatar['y'] + avatar['height'] <= name['y']
        assert name['y'] + name['height'] <= chip['y']
        assert chip['y'] + chip['height'] <= code['y']
        assert code['y'] + code['height'] <= enter['y']
        assert chip['width'] < code['width'], 'current-device badge should stay compact'
        assert page.locator('.entry-avatar #home-device-avatar').count() == 1
        assert page.locator('.entry-device .device-name-line #edit-home-device-name').count() == 1
        assert page.locator('.entry-device-chip').inner_text() == '当前设备'
        assert page.locator('.entry-device-chip #home-device-label').count() == 0
        assert page.locator('.entry-room-code label').inner_text() == '房间号'
        assert page.locator('.entry-room-code #regenerate-code').count() == 1
        assert page.locator('.entry-room-code label').evaluate(
            "node => getComputedStyle(node).textAlign") != 'center'
        assert re.fullmatch(r'\d{4}', page.locator('#room-code-input').input_value())
        assert page.locator('#device-name').count() == 0
        assert page.locator('#room-device-name').count() == 0
        assert re.fullmatch(r'[A-Z][a-z]+ [A-Z][a-z]+', page.locator('#home-device-label').inner_text())
        page.locator('#edit-home-device-name').click()
        assert page.locator('#home-device-label').get_attribute('contenteditable') == 'plaintext-only'
        page.locator('#home-device-label').fill('Coral Fox')
        page.locator('#home-device-label').press('Enter')
        assert page.locator('#home-device-label').inner_text() == 'Coral Fox'
        assert page.locator('#home-device-label').get_attribute('contenteditable') == 'false'
        assert page.locator('#home-device-avatar').inner_text() == '🦊'
        assert page.locator('#toast').is_visible()
        assert page.locator('#toast-message').inner_text() == '设备名称已修改'
        assert page.locator('#toast').get_attribute('role') == 'status'
        bounds = page.locator('#toast').bounding_box()
        assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width
        # Enter-room progress lives inside the button and prevents double entry.
        page.evaluate('setEntryLoading(true)')
        assert page.locator('#enter-room').is_disabled()
        assert page.locator('#entry-loading-icon').is_visible()
        assert page.locator('#entry-button-label').inner_text() == '正在连接房间…'
        assert page.locator('#entry-button-arrow').is_hidden()
        page.evaluate('setEntryLoading(false)')
        assert page.locator('#enter-room').is_enabled()
        assert page.locator('#entry-loading-icon').is_hidden()
        assert page.locator('#entry-button-label').inner_text() == '进入房间'
        # Pairing status is already on the join button. Never repeat it above
        # the existing transfer limitations; retain real errors.
        page.evaluate("feedback('正在连接房间…')")
        assert page.locator('#feedback').is_hidden()
        assert page.locator('.prototype-note').is_visible()
        page.evaluate("feedback('无法连接房间，请重试', true)")
        assert page.locator('#feedback').is_visible()
        assert '无法连接房间' in page.locator('#feedback').inner_text()
        page.evaluate("feedback('')")
        assert page.locator('#feedback').is_hidden()
        # Header status uses distinct offline/waiting/ready color dots.
        status_colors = page.evaluate('''() => {
            const status = document.getElementById('connection-status');
            const color = () => getComputedStyle(status, '::before').backgroundColor;
            status.dataset.state = 'offline';
            const offline = color();
            status.dataset.state = 'waiting';
            const waiting = color();
            status.dataset.state = 'ready';
            const ready = color();
            status.dataset.state = 'offline';
            return [offline, waiting, ready];
        }''')
        assert len(set(status_colors)) == 3, f'connection dot colors indistinguishable: {status_colors}'
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
        # Room feedback must remain visible when the room screen is active.
        page.evaluate("feedback('房间已连接')")
        assert page.locator('#feedback').is_visible()
        assert page.locator('#feedback').inner_text() == '房间已连接'
        # The room title owns its copy icon; no redundant online badge or toolbar copy action.
        assert page.locator('.room-title-line #copy-code').count() == 1
        assert page.locator('#copy-code').get_attribute('aria-label') == '复制房间号'
        assert page.locator('.room-title-line .chip').count() == 0
        assert page.locator('.room-actions #copy-code').count() == 0
        assert page.locator('.room-actions button').count() == 1
        assert page.locator('.room-actions button').inner_text() == '退出'
        page.evaluate('''() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {writeText: async text => { window.__copiedRoom = text; }}
            });
        }''')
        page.locator('#copy-code').click()
        page.wait_for_function("document.getElementById('toast-message').textContent === '房间号已复制'")
        assert page.evaluate('window.__copiedRoom') == 'HOME2026'
        assert page.locator('#toast').is_visible()
        assert page.locator('#peer-list .device-row').count() == 0
        assert page.locator('#drop-target').count() == 0
        assert page.locator('#peer-list button').count() == 0
        # Regression: async SDP processing must finish before later ICE candidates.
        assert page.evaluate('''async () => {
            const observed = [];
            const dispatch = window.__demo.orderedMessageHandler(async message => {
                observed.push('begin-' + message);
                if (message === 'offer') await new Promise(resolve => setTimeout(resolve, 30));
                observed.push('end-' + message);
            }, error => { throw error; });
            await Promise.all([dispatch('offer'), dispatch('candidate')]);
            return observed.join(',');
        }''') == 'begin-offer,end-offer,begin-candidate,end-candidate'
        # Regression: local ICE can appear synchronously inside setLocalDescription.
        # SDP must be relayed before the buffered ICE candidate.
        assert page.evaluate('''async () => {
            const old = window.RTCPeerConnection;
            const log = [];
            class FakePC {
                constructor() { this.connectionState='new'; this.iceConnectionState='new'; }
                createDataChannel() { return {readyState:'connecting'}; }
                createOffer() { return Promise.resolve({type:'offer',sdp:'sdp'}); }
                async setLocalDescription(offer) {
                    this.localDescription=offer;
                    const candidate={candidate:'candidate:1 1 udp 1 192.168.1.2 999 typ host',
                        toJSON(){return {candidate:this.candidate,sdpMid:'0',sdpMLineIndex:0}}};
                    this.onicecandidate({candidate});
                }
                close() { this.connectionState='closed'; }
            }
            window.RTCPeerConnection = FakePC;
            window.__demo.state.ws={readyState:WebSocket.OPEN,send:payload=>log.push(JSON.parse(payload))};
            try {
                const peer=await window.__demo.createPeer('ice-order-test','P',true,'mock-session');
                clearTimeout(peer.connectTimer); peer.pc.close();
                window.__demo.state.peers.delete(peer.id);
                return log.map(x=>x.signal.type).join(',');
            } finally {
                window.RTCPeerConnection=old;
                window.__demo.state.ws=null;
            }
        }''') == 'offer,candidate'
        # A signal from an already-removed session cannot recreate a ghost peer.
        assert page.evaluate('''async () => {
            const d = window.__demo;
            const absent = !d.state.peers.has('stale-peer');
            await d.handleServer({
                type:'signal', from:'stale-peer', fromGeneration:'previous',
                signal:{type:'offer',sdp:'old-sdp'},
            });
            return absent && !d.state.peers.has('stale-peer');
        }''')
        # A visual-only room mock has no actual WebSocket session; it must
        # not claim that the live room is connected.
        assert page.locator('#connection-status').inner_text() == '正在恢复连接'
        assert page.locator('#connection-status').get_attribute('data-state') == 'waiting'
        assert page.locator('#toggle-diagnostics').count() == 1
        # A file can be shared before another device arrives.
        with page.expect_file_chooser() as chooser:
            page.locator('#drop-zone').click()
        chooser.value.set_files({'name': 'first.txt', 'mimeType': 'text/plain', 'buffer': b'hello'})
        assert page.evaluate('window.__demo.state.ownOffers.length') == 1
        assert page.evaluate('window.__messages.length') == 0
        assert page.locator('#sent-files .file-row').count() == 1
        assert page.locator('#sent-files .file-row button').inner_text() == '移除'
        assert '等待设备直连' in page.locator('#sent-files .file-row').inner_text()

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
        # A previous websocket incarnation cannot disconnect a newer one.
        assert page.evaluate('''async () => {
            const d = window.__demo;
            const peer = d.state.peers.get('peer-2');
            peer.generation = 'current-session';
            await d.handleServer({type:'peer-offline',id:'peer-2',generation:'old-session'});
            await d.handleServer({type:'peer-unavailable',id:'peer-2',generation:'old-session'});
            return d.state.peers.get('peer-2') === peer;
        }''')
        assert page.locator('#peer-list .device-row').count() == 3
        assert page.locator('#peer-list button').count() == 0
        # Fake ready peers do not override the intentionally missing WebSocket:
        # a room cannot claim full connectivity with signalling disconnected.
        assert page.locator('#connection-status').inner_text() == '正在恢复连接'
        assert page.locator('#connection-status').get_attribute('data-state') == 'waiting'
        assert '可供 2 台设备接收' in page.locator('#sent-files .file-row').inner_text()
        page.locator('#toggle-diagnostics').click()
        assert page.locator('#diagnostics-panel').is_visible()
        # Selected-path details and signal errors add optional diagnostic rows.
        assert page.locator('#diagnostics-content .diagnostic-line').count() >= 14
        assert '设备：3' in page.locator('#diagnostics-panel').inner_text()
        page.locator('#toggle-diagnostics').click()
        assert page.locator('#diagnostics-panel').is_hidden()
        assert page.locator('#peer-list .device-icon').first.inner_text() == '🐻'
        page.locator('#edit-device-name').click()
        assert page.locator('#my-device-label').get_attribute('contenteditable') == 'plaintext-only'
        page.locator('#my-device-label').fill('Not saved')
        page.locator('#my-device-label').press('Escape')
        assert page.locator('#my-device-label').inner_text() == 'Coral Fox'
        page.locator('#edit-device-name').click()
        page.locator('#my-device-label').fill('Peach Panda')
        page.locator('#my-device-label').press('Enter')
        assert page.locator('#my-device-label').inner_text() == 'Peach Panda'
        assert page.locator('#toast-message').inner_text() == '设备名称已修改'
        assert page.locator('#toast').is_visible()
        assert page.locator('#home-device-label').inner_text() == 'Peach Panda'
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
        assert page.locator('#transfer-jobs').count() == 0
        assert page.locator('#incoming-requests .file-row').count() == 2
        assert page.locator('.request .file-row button').count() == 2
        assert page.locator('.request-footer button').inner_text() == '接收全部 (2)'
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-static.png'), full_page=True)
        page.locator('.request .file-row button').first.click()
        assert page.evaluate('window.__demo.state.jobs.length') == 1
        assert page.locator('#incoming-requests .file-row').count() == 2
        assert page.locator('#incoming-requests .job-row').count() == 1
        assert page.locator('#incoming-requests .job-row button').inner_text() == '取消'
        page.locator('.request-footer button').click()
        assert page.evaluate('window.__demo.state.jobs.length') == 2
        assert page.evaluate('window.__demo.state.queue.length') == 1
        assert page.locator('#incoming-requests .file-row').count() == 2
        assert page.locator('#incoming-requests .job-row').count() == 2
        assert page.locator('.request input[type=checkbox]').count() == 0

        # The same entry shows live progress, then a Save action without duplication.
        page.evaluate('''() => {
            const d = window.__demo;
            const job = d.state.jobs[0];
            job.received = job.size / 2;
            job.status = '传输中';
            d.renderRoomFiles();
        }''')
        assert '传输中' in page.locator('#incoming-requests .job-row').first.inner_text()
        assert page.locator('#incoming-requests .job-row .progress > div').first.get_attribute('style') == 'width: 50%;'
        page.evaluate('''() => {
            const d = window.__demo;
            const job = d.state.jobs[0];
            job.received = job.size;
            job.status = '校验通过，点击保存';
            job.url = 'blob:test-received';
            d.state.active = null;
            d.state.offers.get('peer-1:received').files.find(f => f.id === job.fileId).status = 'complete';
            d.renderRoomFiles();
        }''')
        assert page.locator('#incoming-requests .file-row').count() == 2
        assert page.locator('#incoming-requests a.download-link[download="Design.pdf"]').count() == 1

        # The next file can fail and expose Retry in its original row.
        page.evaluate('''() => {
            const d = window.__demo;
            const job = d.state.jobs[1];
            d.state.queue = d.state.queue.filter(item => item !== job);
            job.status = '失败：模拟连接中断';
            d.state.offers.get('peer-1:received').files.find(f => f.id === job.fileId).status = 'failed';
            d.renderRoomFiles();
        }''')
        assert page.locator('#incoming-requests .job-row button').inner_text() == '重试'
        page.locator('#incoming-requests .job-row button').click()
        assert page.evaluate('window.__demo.state.jobs.length') == 2
        assert page.locator('#incoming-requests .job-row').count() == 2

        # Withdrawal propagates to every connected device without affecting other files.
        page.locator('#sent-files .file-row button').first.click()
        assert page.locator('#sent-files .file-row').count() == 1
        assert page.evaluate('window.__messages.filter(m => m.packet.kind === "file-withdraw").length') == 3
        # Files shared by disconnected uploader disappear, rather than implying cloud storage.
        page.evaluate('''async () => {
            const d = window.__demo;
            await d.handleServer({type:'peer-offline', id:'peer-1'});
        }''')
        assert page.locator('#incoming-requests .request').count() == 1
        assert '已撤回或离线的文件' in page.locator('#incoming-requests').inner_text()
        assert page.locator('#incoming-requests .file-row').count() == 2
        assert page.locator('#incoming-requests a.download-link[download="Design.pdf"]').count() == 1
        page.screenshot(path=str(ROOT / 'docs' / f'room-{label}-queue-static.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), f'{label} horizontal overflow'
        assert not errors, errors
        print(f'PASS: {label} room broadcast, late join sync, withdrawal, receive queue, rename, no overflow')
        page.close()
    browser.close()
