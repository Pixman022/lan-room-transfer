import asyncio
import unittest

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

    def test_invalid_codes(self):
        rooms = RoomRegistry()
        for code in ("abc", "with-space", "a" * 17, "a_4c", None):
            with self.subTest(code=code), self.assertRaises(ValueError):
                rooms.validate_code(code)


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
        await a.send_json({"type": "signal", "to": welcome_b["id"],
                           "signal": {"type": "file-chunk", "data": "file bytes"}})
        error = await a.receive_json()
        self.assertEqual(error["type"], "error")
        await a.send_json({"type": "signal", "to": welcome_b["id"],
                           "signal": {"type": "offer", "sdp": "fake sdp"}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["type"], "signal")
        self.assertEqual(forwarded["from"], welcome_a["id"])
        await b.close()
        self.assertEqual((await a.receive_json())["type"], "peer-offline")
        await a.close()

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
        self.assertIn({"id": first["id"], "name": "Laptop-New"}, joined["peers"])
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
        await a.send_json({"type": "signal", "to": b_welcome["id"], "signal": {
            "type": "candidate", "candidate": {"candidate": "", "sdpMid": "0", "sdpMLineIndex": 0}}})
        forwarded = await b.receive_json()
        self.assertEqual(forwarded["signal"]["candidate"]["candidate"], "")
        await a.send_json({"type": "signal", "to": b_welcome["id"], "signal": {
            "type": "candidate", "candidate": {
                "candidate": "candidate:1 1 udp 1 203.0.113.1 11111 typ srflx", "sdpMid": "0"}}})
        self.assertEqual((await a.receive_json())["type"], "error")
        await a.close()
        await b.close()

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
        await a.send_json({"type": "signal", "to": "missing", "signal": {"type": "offer", "sdp": "abc"}})
        self.assertEqual((await a.receive_json())["type"], "error")
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
