import asyncio
import unittest
from unittest.mock import patch

from aiohttp.test_utils import AioHTTPTestCase

from server import RoomRegistry, create_app, send


class ClosedSocketTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_ignores_transport_closed_during_write(self):
        class ClosingWebSocket:
            closed = False
            async def send_json(self, _):
                raise ConnectionResetError('Cannot write to closing transport')
        await send(ClosingWebSocket(), {'type': 'peer-offline'})


class RoomUnitTests(unittest.TestCase):
    def test_first_enter_creates_following_enter_joins_and_code_is_reusable(self):
        now = [1000.0]
        rooms = RoomRegistry(clock=lambda: now[0])
        class StubWs:
            closed = False
        room, first, created = rooms.enter("home2026", "Laptop", StubWs())
        self.assertTrue(created)
        self.assertEqual(room.code, "HOME2026")
        same_room, second, created = rooms.enter("Home2026", "Phone", StubWs())
        self.assertIs(same_room, room)
        self.assertFalse(created)
        self.assertNotEqual(first.id, second.id)
        rooms.leave(room, first, first.ws)
        rooms.leave(room, second, second.ws)
        room.empty_at = now[0]
        now[0] += 119
        self.assertIn(room.code, rooms.rooms)
        now[0] += 2
        new_room, _, created = rooms.enter("HOME2026", "New laptop", StubWs())
        self.assertTrue(created)
        self.assertIsNot(new_room, room)

    def test_suggested_random_code_is_unused_but_does_not_reserve(self):
        now = [900.0]
        rooms = RoomRegistry(clock=lambda: now[0])
        class StubWs:
            closed = False
        code = rooms.suggest_code()
        self.assertRegex(code, r"^\d{4}$")
        self.assertNotIn(code, rooms.rooms)
        room, _, created = rooms.enter(code, "PC", StubWs())
        self.assertTrue(created)
        self.assertNotEqual(rooms.suggest_code(), code)
        now[0] += 301
        joined, _, created = rooms.enter(code, "Phone", StubWs())
        self.assertIs(joined, room)
        self.assertFalse(created)

    def test_failed_enter_does_not_leave_empty_room(self):
        rooms = RoomRegistry()
        with self.assertRaisesRegex(ValueError, "设备名称"):
            rooms.enter("1234", "", object())
        self.assertNotIn("1234", rooms.rooms)

    def test_owner_departure_does_not_end_room_and_idle_grace(self):
        now = [1000.0]
        rooms = RoomRegistry(clock=lambda: now[0])
        class StubWs:
            closed = False
        ws_a, ws_b = StubWs(), StubWs()
        room, a, _ = rooms.enter("ROOM2026", "Creator", ws_a)
        _, b, _ = rooms.enter("ROOM2026", "Member", ws_b)
        rooms.leave(room, a, ws_a)
        self.assertEqual([m.name for m in room.online()], ["Member"])
        self.assertIsNone(room.empty_at)
        rooms.leave(room, b, ws_b)
        self.assertEqual(room.empty_at, 1000.0)
        now[0] += 60
        self.assertIn("ROOM2026", rooms.rooms)
        now[0] += 61
        rooms.sweep()
        self.assertNotIn("ROOM2026", rooms.rooms)

    def test_authenticated_refresh_reuses_member_and_replaces_socket(self):
        rooms = RoomRegistry()
        class StubWs:
            closed = False
        old_ws, new_ws = StubWs(), StubWs()
        room, original, _ = rooms.enter("ABCD", "Phone", old_ws)
        old_generation = original.generation
        resumed, same_member, created = rooms.enter(
            "ABCD", "Phone", new_ws, original.id, original.token)
        self.assertIs(resumed, room)
        self.assertIs(same_member, original)
        self.assertFalse(created)
        self.assertNotEqual(same_member.generation, old_generation)
        self.assertEqual(len(room.online()), 1)
        rooms.leave(room, original, old_ws)
        self.assertIs(original.ws, new_ws)
        self.assertIsNone(room.empty_at)

    def test_invalid_codes(self):
        rooms = RoomRegistry()
        for code in ("abc", "with-space", "a" * 17, "a_4c", None):
            with self.subTest(code=code), self.assertRaises(ValueError):
                rooms.validate_code(code)



class RoomLifecycleIntegrationTests(AioHTTPTestCase):
    async def get_application(self):
        self.now = [1000.0]
        self.registry = RoomRegistry(clock=lambda: self.now[0])
        return create_app(registry=self.registry)

    async def enter(self, code, name, previous=None):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        ws = await self.client.ws_connect("/ws", headers=origin)
        payload = {"type": "enter", "code": code, "name": name}
        if previous:
            payload.update(id=previous["id"], token=previous["token"])
        await ws.send_json(payload)
        welcome = await ws.receive_json(timeout=2)
        self.assertEqual(welcome["type"], "welcome")
        return ws, welcome

    async def until(self, predicate):
        # WebSocket close callbacks run asynchronously. Wait for cleanup, not
        # for the 120-second test clock to elapse in real time.
        for _ in range(100):
            if predicate():
                return
            await asyncio.sleep(0.01)
        self.fail("WebSocket teardown did not reach the expected room state")

    async def test_creator_leaves_and_last_member_can_resume_until_exact_expiry(self):
        code = "TESTROOM26"
        a, a_info = await self.enter(code, "Creator")
        self.assertTrue(a_info["created"])
        b, b_info = await self.enter(code, "Member B")
        self.assertFalse(b_info["created"])
        self.assertEqual((await a.receive_json(timeout=2))["type"], "peer-online")
        c, c_info = await self.enter(code, "Member C")
        self.assertFalse(c_info["created"])
        self.assertEqual(len(c_info["peers"]), 2)
        self.assertEqual((await a.receive_json(timeout=2))["type"], "peer-online")
        self.assertEqual((await b.receive_json(timeout=2))["type"], "peer-online")
        room = self.registry.rooms[code]
        self.assertEqual(len(room.online()), 3)

        # Creator departure does not expire the room or interrupt the two
        # remaining sockets: the server must still forward targeted signaling.
        await a.close()
        self.assertEqual((await b.receive_json(timeout=2))["type"], "peer-offline")
        self.assertEqual((await c.receive_json(timeout=2))["type"], "peer-offline")
        self.assertEqual(len(room.online()), 2)
        self.assertIsNone(room.empty_at)
        await b.send_json({"type": "signal", "to": c_info["id"],
                           "toGeneration": c_info["generation"],
                           "signal": {"type": "offer", "attempt": 1, "sdp": "test-offer"}})
        forwarded = await c.receive_json(timeout=2)
        self.assertEqual(forwarded["type"], "signal")
        self.assertEqual(forwarded["from"], b_info["id"])
        self.assertEqual(forwarded["signal"]["sdp"], "test-offer")

        await b.close()
        self.assertEqual((await c.receive_json(timeout=2))["type"], "peer-offline")
        await c.close()
        await self.until(lambda: room.empty_at == self.now[0])
        self.assertIs(self.registry.rooms[code], room)

        # A valid browser session resumes the same identity and room during
        # the 2-minute grace window, resetting the idle expiry clock.
        self.now[0] += 119
        resumed, resumed_info = await self.enter(code, "Member B", b_info)
        self.assertFalse(resumed_info["created"])
        self.assertEqual(resumed_info["id"], b_info["id"])
        self.assertNotEqual(resumed_info["generation"], b_info["generation"])
        self.assertIs(self.registry.rooms[code], room)
        self.assertIsNone(room.empty_at)
        await resumed.close()
        await self.until(lambda: room.empty_at == self.now[0])

        # The room remains reserved up to but not including 120s idle.
        self.now[0] += 119
        self.registry.sweep()
        self.assertIs(self.registry.rooms[code], room)
        self.now[0] += 1
        fresh, new_info = await self.enter(code, "New Member", b_info)
        self.assertTrue(new_info["created"])
        self.assertNotEqual(new_info["id"], b_info["id"])
        self.assertEqual(new_info["peers"], [])
        self.assertIsNot(self.registry.rooms[code], room)
        self.assertEqual(len(self.registry.rooms[code].members), 1)
        await fresh.close()


class SignallingTests(AioHTTPTestCase):
    async def get_application(self):
        return create_app()

    async def test_room_members_signal_only_and_disconnect(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "HELLO2026", "name": "Laptop"})
        welcome_a = await a.receive_json()
        self.assertEqual(welcome_a["code"], "HELLO2026")
        self.assertEqual(welcome_a["peers"], [])
        self.assertTrue(welcome_a["created"])
        b = await self.client.ws_connect("/ws", headers=origin)
        await b.send_json({"type": "enter", "code": "hello2026", "name": "Phone"})
        welcome_b = await b.receive_json()
        self.assertEqual(welcome_b["peers"][0]["name"], "Laptop")
        self.assertFalse(welcome_b["created"])
        self.assertEqual((await a.receive_json())["type"], "peer-online")
        await a.send_json({"type": "signal", "to": welcome_b["id"], "toGeneration": welcome_b["generation"],
                           "signal": {"type": "file-chunk", "data": "file bytes"}})
        error = await a.receive_json()
        self.assertEqual(error["type"], "error")
        await a.send_json({"type": "signal", "to": welcome_b["id"], "toGeneration": welcome_b["generation"],
                           "signal": {"type": "offer", "sdp": "fake sdp"}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["type"], "signal")
        self.assertEqual(forwarded["from"], welcome_a["id"])
        await b.close()
        self.assertEqual((await a.receive_json())["type"], "peer-offline")
        await a.close()

    async def test_peer_online_precedes_welcome_and_immediate_first_offer(self):
        # The joining browser immediately offers after welcome. Ensure that an
        # already-present browser has received its peer-online notification
        # before the server can forward that offer on the same WebSocket.
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        phone = await self.client.ws_connect("/ws", headers=origin)
        await phone.send_json({"type": "enter", "code": "FIRSTOFFER", "name": "Phone"})
        phone_welcome = await phone.receive_json()

        calls = []
        async def recorded_send(ws, payload):
            if payload.get("type") in ("peer-online", "welcome"):
                calls.append(payload["type"])
            return await send(ws, payload)

        pc = await self.client.ws_connect("/ws", headers=origin)
        with patch("server.send", new=recorded_send):
            await pc.send_json({"type": "enter", "code": "FIRSTOFFER", "name": "PC"})
            pc_welcome = await pc.receive_json()
            await pc.send_json({
                "type": "signal", "to": phone_welcome["id"],
                "toGeneration": phone_welcome["generation"],
                "signal": {"type": "offer", "attempt": 1, "sdp": "first-offer"},
            })
            presence = await phone.receive_json()
            offer = await phone.receive_json()

        self.assertEqual(calls, ["peer-online", "welcome"])
        self.assertEqual(presence["type"], "peer-online")
        self.assertEqual(presence["id"], pc_welcome["id"])
        self.assertEqual(presence["generation"], pc_welcome["generation"])
        self.assertEqual(offer["type"], "signal")
        self.assertEqual(offer["from"], pc_welcome["id"])
        self.assertEqual(offer["signal"]["sdp"], "first-offer")
        await pc.close()
        await phone.close()

    async def test_rapid_refresh_replaces_socket_and_rejects_stale_generation(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "REJOIN", "name": "A"})
        a_join = await a.receive_json()
        b = await self.client.ws_connect("/ws", headers=origin)
        await b.send_json({"type": "enter", "code": "REJOIN", "name": "B"})
        first_b = await b.receive_json()
        original_online = await a.receive_json()
        self.assertEqual(original_online["type"], "peer-online")
        self.assertEqual(original_online["generation"], first_b["generation"])

        # The replacement arrives before the old websocket has fully closed.
        new_b = await self.client.ws_connect("/ws", headers=origin)
        await new_b.send_json({"type": "enter", "code": "REJOIN", "name": "B",
                               "id": first_b["id"], "token": first_b["token"]})
        offline = await a.receive_json()
        self.assertEqual(offline, {"type": "peer-offline", "id": first_b["id"],
                                   "generation": first_b["generation"]})
        resumed = await new_b.receive_json()
        self.assertEqual(resumed["id"], first_b["id"])
        self.assertNotEqual(resumed["generation"], first_b["generation"])
        online = await a.receive_json()
        self.assertEqual(online["type"], "peer-online")
        self.assertEqual(online["generation"], resumed["generation"])
        await asyncio.sleep(0.04)
        members = self.app["registry"].rooms["REJOIN"].online()
        self.assertEqual(len(members), 2)
        self.assertEqual({m.id for m in members}, {a_join["id"], first_b["id"]})

        # An old ICE/SDP target cannot contaminate the replacement socket.
        await a.send_json({"type": "signal", "to": first_b["id"],
                           "toGeneration": first_b["generation"],
                           "signal": {"type": "offer", "sdp": "stale"}})
        denied = await a.receive_json()
        self.assertEqual(denied["type"], "peer-unavailable")
        self.assertEqual(denied["generation"], first_b["generation"])

        await a.send_json({"type": "signal", "to": first_b["id"],
                           "toGeneration": resumed["generation"],
                           "signal": {"type": "offer", "sdp": "new"}})
        forwarded = await new_b.receive_json()
        self.assertEqual(forwarded["type"], "signal")
        self.assertEqual(forwarded["fromGeneration"], a_join["generation"])
        self.assertEqual(forwarded["signal"]["sdp"], "new")
        await a.close()
        await new_b.close()
        await b.close()

    async def test_device_rename_broadcast_preserves_member_identity(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "TESTNAME", "name": "Default-A"})
        first = await a.receive_json()
        self.assertEqual(first["name"], "Default-A")
        b = await self.client.ws_connect("/ws", headers=origin)
        await b.send_json({"type": "enter", "code": "TESTNAME", "name": "Default-B"})
        await b.receive_json()
        await a.receive_json()  # peer-online
        await a.send_json({"type": "rename", "name": "Laptop-New"})
        notification = await b.receive_json()
        self.assertEqual(notification, {"type": "peer-name", "id": first["id"], "name": "Laptop-New"})
        c = await self.client.ws_connect("/ws", headers=origin)
        await c.send_json({"type": "enter", "code": "TESTNAME", "name": "Device-C"})
        joined = await c.receive_json()
        self.assertIn({"id": first["id"], "name": "Laptop-New",
                       "generation": first["generation"]}, joined["peers"])
        await a.close()
        await b.close()
        await c.close()

    async def test_ice_end_of_candidates_is_forwarded_without_enabling_relay(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "EOCROOM", "name": "A"})
        await a.receive_json()
        b = await self.client.ws_connect("/ws", headers=origin)
        await b.send_json({"type": "enter", "code": "EOCROOM", "name": "B"})
        b_welcome = await b.receive_json()
        await a.receive_json()  # peer-online
        await a.send_json({"type": "signal", "to": b_welcome["id"], "toGeneration": b_welcome["generation"], "signal": {
            "type": "candidate", "candidate": {"candidate": "", "sdpMid": "0", "sdpMLineIndex": 0}}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["signal"]["candidate"]["candidate"], "")
        # Valid host candidates may end with "typ host" (no trailing space).
        host = "candidate:1 1 udp 100 192.168.1.5 5555 typ host"
        for raw in [host, host + " generation 0"]:
            await a.send_json({"type": "signal", "to": b_welcome["id"], "toGeneration": b_welcome["generation"], "signal": {
                "type": "candidate", "candidate": {"candidate": raw, "sdpMid": "0"}}})
            self.assertEqual((await b.receive_json())["signal"]["candidate"]["candidate"], raw)
        await a.send_json({"type": "signal", "to": b_welcome["id"], "toGeneration": b_welcome["generation"], "signal": {
            "type": "candidate", "candidate": {
                "candidate": "candidate:1 1 udp 1 203.0.113.1 11111 typ srflx", "sdpMid": "0"}}})
        self.assertEqual((await a.receive_json())["type"], "error")
        await a.close()
        await b.close()

    async def test_stalled_ice_retry_signalling_and_attempt_rejection(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "ICERETRY", "name": "A"})
        a_welcome = await a.receive_json()
        b = await self.client.ws_connect("/ws", headers=origin)
        await b.send_json({"type": "enter", "code": "ICERETRY", "name": "B"})
        b_welcome = await b.receive_json()
        await a.receive_json()  # peer-online

        await b.send_json({"type": "signal", "to": a_welcome["id"],
                           "toGeneration": a_welcome["generation"],
                           "signal": {"type": "retry", "attempt": 1}})
        forwarded = await a.receive_json()
        self.assertEqual(forwarded["type"], "signal")
        self.assertEqual(forwarded["fromGeneration"], b_welcome["generation"])
        self.assertEqual(forwarded["signal"], {"type": "retry", "attempt": 1})

        await a.send_json({"type": "signal", "to": b_welcome["id"],
                           "toGeneration": b_welcome["generation"],
                           "signal": {"type": "offer", "attempt": 2, "sdp": "retry-sdp"}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["signal"]["attempt"], 2)

        # The fourth attempt reverses offerer/answerer roles, but still carries
        # only an ICE retry or host-only SDP/candidates through signalling.
        await a.send_json({"type": "signal", "to": b_welcome["id"],
                           "toGeneration": b_welcome["generation"],
                           "signal": {"type": "retry", "attempt": 4}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["signal"], {"type": "retry", "attempt": 4})
        await b.send_json({"type": "signal", "to": a_welcome["id"],
                           "toGeneration": a_welcome["generation"],
                           "signal": {"type": "offer", "attempt": 4, "sdp": "reverse-offer"}})
        forwarded = await a.receive_json()
        self.assertEqual(forwarded["signal"]["attempt"], 4)

        for payload in (
            {"type": "retry", "attempt": -1},
            {"type": "retry", "attempt": True},
            {"type": "retry", "attempt": 5},
            {"type": "offer", "attempt": 5, "sdp": "invalid"},
            {"type": "retry", "attempt": 1, "sdp": "extra"},
        ):
            await a.send_json({"type": "signal", "to": b_welcome["id"],
                               "toGeneration": b_welcome["generation"], "signal": payload})
            self.assertEqual((await a.receive_json())["type"], "error")
        await a.close()
        await b.close()

    async def test_checksum_module_is_served(self):
        response = await self.client.get("/static/checksum.js")
        self.assertEqual(response.status, 200)
        self.assertIn("verifySha256", await response.text())

    async def test_device_name_module_is_served(self):
        response = await self.client.get("/static/device-name.js")
        self.assertEqual(response.status, 200)
        self.assertIn("generateDeviceName", await response.text())

    async def test_room_code_suggestion_is_not_occupied_and_module_is_served(self):
        first = await self.client.get("/api/suggest-code")
        self.assertEqual(first.status, 200)
        code = (await first.json())["code"]
        self.assertRegex(code, r"^\d{4}$")
        self.assertNotIn(code, self.app["registry"].rooms)
        module = await self.client.get("/static/room-code.js")
        self.assertEqual(module.status, 200)
        self.assertIn("generateRandomRoomCode", await module.text())

    async def test_simultaneous_enter_same_code_stays_one_room(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        b = await self.client.ws_connect("/ws", headers=origin)
        await asyncio.gather(
            a.send_json({"type": "enter", "code": "4488", "name": "A"}),
            b.send_json({"type": "enter", "code": "4488", "name": "B"}),
        )
        responses = []
        for ws in (a, b):
            for _ in range(2):
                msg = await ws.receive_json(timeout=2)
                if msg["type"] == "welcome":
                    responses.append(msg)
                    break
        self.assertEqual(sorted(response["created"] for response in responses), [False, True])
        self.assertEqual(len(self.app["registry"].rooms), 1)
        self.assertEqual(len(self.app["registry"].rooms["4488"].online()), 2)
        await a.close()
        await b.close()

    async def test_no_binary_relay_and_host_candidate_only(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "ROOM9999", "name": "PC"})
        await a.receive_json()
        await a.send_bytes(b"This is a file byte payload")
        self.assertEqual((await a.receive_json())["type"], "error")
        await a.send_json({"type": "signal", "to": "missing", "toGeneration": "old",
                           "signal": {"type": "offer", "sdp": "abc"}})
        unavailable = await a.receive_json()
        self.assertEqual(unavailable["type"], "peer-unavailable")
        self.assertEqual(unavailable["id"], "missing")
        await a.close()

    async def test_resume_and_origin_rejection(self):
        origin = {"Origin": str(self.server.make_url("/"))[:-1]}
        a = await self.client.ws_connect("/ws", headers=origin)
        await a.send_json({"type": "enter", "code": "5832", "name": "PC"})
        original = await a.receive_json()
        await a.close()
        await asyncio.sleep(0.03)
        resumed = await self.client.ws_connect("/ws", headers=origin)
        await resumed.send_json({"type": "enter", "code": original["code"], "name": "PC",
                                 "id": original["id"], "token": original["token"]})
        response = await resumed.receive_json()
        self.assertEqual(response["type"], "welcome")
        self.assertEqual(response["id"], original["id"])
        self.assertFalse(response["created"])
        await resumed.close()
        bad = await self.client.get("/ws", headers={"Origin": "https://attacker.example"})
        self.assertEqual(bad.status, 403)


if __name__ == "__main__":
    unittest.main()
