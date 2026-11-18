"""Development signalling server for a browser LAN file-transfer proof of concept.

Only room presence and tightly-scoped WebRTC signalling are relayed here.
File metadata and bytes travel only on the WebRTC data channel.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
CODE_RE = re.compile(r"^[A-Z0-9]{4,16}$")
ROOM_IDLE_SECONDS = 120
MAX_ONLINE_MEMBERS = 10
MAX_MESSAGE_BYTES = 65536


@dataclass
class Member:
    id: str
    token: str
    name: str
    ws: web.WebSocketResponse | None = None


@dataclass
class Room:
    code: str
    created_at: float
    members: dict[str, Member] = field(default_factory=dict)
    empty_at: float | None = None

    def online(self):
        return [member for member in self.members.values() if member.ws is not None and not member.ws.closed]

    def is_closed(self, now):
        return self.empty_at is not None and now - self.empty_at >= ROOM_IDLE_SECONDS


class RoomRegistry:
    def __init__(self, clock=time.monotonic):
        self.rooms: dict[str, Room] = {}
        self.clock = clock

    def validate_code(self, code):
        if not isinstance(code, str):
            raise ValueError("房间码必须是 4–16 位字母或数字")
        code = code.strip().upper()
        if not CODE_RE.fullmatch(code):
            raise ValueError("房间码必须是 4–16 位字母或数字")
        return code

    def sweep(self):
        now = self.clock()
        for code, room in list(self.rooms.items()):
            if room.is_closed(now):
                del self.rooms[code]

    def suggest_code(self):
        self.sweep()
        available = [f"{n:04d}" for n in range(10000) if f"{n:04d}" not in self.rooms]
        if not available:
            raise ValueError("四位随机码已用完")
        return secrets.choice(available)

    def enter(self, code, name, ws, id_=None, token=None):
        """Use the code as the room key: first entrant creates, others join.

        Existing member identity is resumed when a valid session token is sent.
        No empty room is left behind if the name or capacity check fails.
        """
        self.sweep()
        code = self.validate_code(code)
        room = self.rooms.get(code)
        if room is not None and isinstance(id_, str) and isinstance(token, str):
            try:
                resumed_room, member = self.resume(code, id_, token, ws)
                return resumed_room, member, False
            except ValueError:
                pass  # Re-enter without the old identity; entry needs no approval.
        created = room is None
        if created:
            room = Room(code=code, created_at=self.clock())
        member = self.add_member(room, name, ws)
        if created:
            self.rooms[code] = room
        return room, member, created

    def add_member(self, room, name, ws):
        if len(room.online()) >= MAX_ONLINE_MEMBERS:
            raise ValueError("房间在线设备已达到上限")
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
            raise ValueError("设备名称长度应为 1–40 字符")
        member = Member(id=secrets.token_urlsafe(12), token=secrets.token_urlsafe(32), name=name.strip(), ws=ws)
        room.members[member.id] = member
        room.empty_at = None
        return member

    def resume(self, code, id_, token, ws):
        self.sweep()
        room = self.rooms.get(self.validate_code(code))
        if room is None:
            raise ValueError("房间已关闭")
        member = room.members.get(id_)
        if member is None or not isinstance(token, str) or not secrets.compare_digest(member.token, token):
            raise ValueError("会话无法恢复")
        if member.ws is not None and not member.ws.closed:
            raise ValueError("此设备的房间会话已在其他页面使用")
        if len(room.online()) >= MAX_ONLINE_MEMBERS:
            raise ValueError("房间在线设备已达到上限")
        member.ws = ws
        room.empty_at = None
        return room, member

    def leave(self, room, member, ws):
        if member.ws is not ws:
            return
        member.ws = None
        if not room.online():
            room.empty_at = self.clock()


async def send(ws, payload):
    if ws is None or ws.closed:
        return
    try:
        await ws.send_json(payload)
    except (ConnectionResetError, RuntimeError):
        # A peer may close between the socket check and the write (e.g. during redeploy).
        # Treat it as disconnected instead of breaking cleanup for other room members.
        pass


async def announce(room, payload, except_id=None):
    for other in room.online():
        if other.id != except_id:
            await send(other.ws, payload)


async def sweep_rooms(app):
    try:
        while True:
            await asyncio.sleep(5)
            app["registry"].sweep()
    except asyncio.CancelledError:
        pass


async def task_context(app):
    task = asyncio.create_task(sweep_rooms(app))
    yield
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def ws_handler(request):
    origin = request.headers.get("Origin")
    expected = request.app["origin"] or f"{request.scheme}://{request.host}"
    if origin != expected:
        raise web.HTTPForbidden(text="WebSocket origin rejected")
    # These are operational limits, not a complete public-service abuse defence.
    ip = request.remote or "unknown"
    registry = request.app["registry"]
    ws = web.WebSocketResponse(max_msg_size=MAX_MESSAGE_BYTES, heartbeat=25)
    await ws.prepare(request)
    room = None
    member = None

    async for msg in ws:
        if msg.type != WSMsgType.TEXT:
            if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
            await send(ws, {"type": "error", "message": "仅支持 JSON 信令消息"})
            continue
        now = time.monotonic()
        traffic = request.app["rate"][ip]
        traffic.append(now)
        while traffic and now - traffic[0] > 60:
            traffic.popleft()
        if len(traffic) > 120:
            await send(ws, {"type": "error", "message": "请求过于频繁，请稍后重试"})
            await ws.close(code=1008)
            break
        try:
            data = json.loads(msg.data)
            if not isinstance(data, dict):
                raise ValueError("信令消息格式无效")
            kind = data.get("type")
            if kind == "enter":
                if room is not None:
                    raise ValueError("请先离开当前房间")
                attempts = request.app["join_rate"][ip]
                attempts.append(now)
                while attempts and now - attempts[0] > 60:
                    attempts.popleft()
                if len(attempts) > 15:
                    raise ValueError("房间操作过于频繁")
                new_room, new_member, created = registry.enter(
                    data.get("code"), data.get("name"), ws, data.get("id"), data.get("token"))
                room, member = new_room, new_member
                peers = [{"id": p.id, "name": p.name} for p in room.online() if p.id != member.id]
                await send(ws, {"type": "welcome", "code": room.code, "id": member.id, "token": member.token,
                                "name": member.name, "peers": peers, "created": created})
                await announce(room, {"type": "peer-online", "id": member.id, "name": member.name}, member.id)
            elif kind == "rename":
                if not room or not member:
                    raise ValueError("尚未加入房间")
                name = data.get("name")
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40:
                    raise ValueError("设备名称无效")
                member.name = name.strip()
                await announce(room, {"type": "peer-name", "id": member.id, "name": member.name}, member.id)
            elif kind == "signal":
                if not room or not member:
                    raise ValueError("尚未加入房间")
                target = room.members.get(data.get("to"))
                signal = data.get("signal")
                if not target or target.ws is None or target.ws.closed or target.id == member.id:
                    raise ValueError("目标设备已离线")
                if (not isinstance(signal, dict) or signal.get("type") not in ("offer", "answer", "candidate")
                        or set(signal) - {"type", "sdp", "candidate"}):
                    raise ValueError("不允许的信令消息类型")
                if signal["type"] in ("offer", "answer"):
                    if not isinstance(signal.get("sdp"), str) or len(signal["sdp"]) > 45000:
                        raise ValueError("SDP 格式不正确")
                else:
                    candidate = signal.get("candidate")
                    if not isinstance(candidate, dict):
                        raise ValueError("ICE 候选信息格式无效")
                    if set(candidate) - {"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"}:
                        raise ValueError("ICE 候选信息包含多余字段")
                    raw = candidate.get("candidate")
                    if (not isinstance(raw, str) or len(raw) > 4096 or
                            (raw != "" and (not raw.startswith("candidate:") or not re.search(r"\btyp host\b", raw)))):
                        raise ValueError("仅允许 host ICE 候选或候选收集结束标记")
                    if candidate.get("sdpMid") is not None and (not isinstance(candidate["sdpMid"], str) or len(candidate["sdpMid"]) > 64):
                        raise ValueError("sdpMid 无效")
                    if candidate.get("sdpMLineIndex") is not None and (type(candidate["sdpMLineIndex"]) is not int or not 0 <= candidate["sdpMLineIndex"] <= 64):
                        raise ValueError("sdpMLineIndex 无效")
                    if candidate.get("usernameFragment") is not None and (not isinstance(candidate["usernameFragment"], str) or len(candidate["usernameFragment"]) > 256):
                        raise ValueError("ICE 用户片段无效")
                await send(target.ws, {"type": "signal", "from": member.id, "signal": signal})
            else:
                raise ValueError("未知的信令命令")
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            await send(ws, {"type": "error", "message": str(exc)})

    if room and member:
        registry.leave(room, member, ws)
        await announce(room, {"type": "peer-offline", "id": member.id}, member.id)
    return ws


async def home(_):
    return web.FileResponse(ROOT / "public" / "index.html")


async def suggest_code(request):
    try:
        return web.json_response({"code": request.app["registry"].suggest_code()})
    except ValueError as exc:
        raise web.HTTPServiceUnavailable(text=str(exc)) from exc


async def assets(request):
    path = request.match_info["filename"]
    if path not in {"app.js", "styles.css", "route-policy.js", "device-name.js", "room-code.js"}:
        raise web.HTTPNotFound()
    return web.FileResponse(ROOT / "public" / path)


@web.middleware
async def secure_headers(request, handler):
    response = await handler(request)
    response.headers.update({
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "Content-Security-Policy": ("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; "
                                    "img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"),
    })
    return response


def create_app(registry=None, origin=None):
    app = web.Application(middlewares=[secure_headers], client_max_size=MAX_MESSAGE_BYTES)
    app["registry"] = registry or RoomRegistry()
    app["origin"] = origin
    app["rate"] = defaultdict(deque)
    app["join_rate"] = defaultdict(deque)
    app.router.add_get("/", home)
    app.router.add_get("/static/{filename}", assets)
    app.router.add_get("/api/suggest-code", suggest_code)
    app.router.add_get("/health", lambda _: web.json_response({"ok": True, "service": "signal-only"}))
    app.router.add_get("/ws", ws_handler)
    app.cleanup_ctx.append(task_context)
    return app


if __name__ == "__main__":
    # Bind only to localhost by default. Production should use trusted HTTPS reverse proxy.
    public_origin = os.getenv("PUBLIC_ORIGIN") or os.getenv("RENDER_EXTERNAL_URL")
    web.run_app(create_app(origin=public_origin), host=os.getenv("HOST", "127.0.0.1"),
                port=int(os.getenv("PORT", "8765")))
