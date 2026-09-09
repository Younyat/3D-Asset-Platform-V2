#!/usr/bin/env python3
import argparse
import json
import math
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


DEFAULT_JOINTS = [
    ("j1", "J1 - Giro base", -3.14, 3.14),
    ("j2", "J2 - Hombro adelante/atras", -1.75, 1.75),
    ("j3", "J3 - Elevacion arriba/abajo", -2.2, 2.2),
    ("j4", "J4 - Muneca arriba/abajo", -3.14, 3.14),
    ("j5", "J5 - Muneca derecha/izquierda", -3.14, 3.14),
    ("j6", "J6 - Giro rotatorio herramienta", -3.14, 3.14),
]


def clamp(value, lower, upper):
    return max(lower, min(upper, value))


def encode_f32_words(value):
    raw = struct.pack(">f", float(value))
    return [int.from_bytes(raw[0:2], "big"), int.from_bytes(raw[2:4], "big")]


def words_to_hex(words):
    return " ".join(f"0x{word:04X}" for word in words)


def modbus_tcp_hex(transaction_id, unit_id, pdu):
    length = len(pdu) + 1
    frame = [
        (transaction_id >> 8) & 0xFF,
        transaction_id & 0xFF,
        0x00,
        0x00,
        (length >> 8) & 0xFF,
        length & 0xFF,
        unit_id,
        *pdu,
    ]
    return " ".join(f"{byte:02X}" for byte in frame)


class RobotModbusState:
    def __init__(self):
        self.lock = threading.Lock()
        self.started_at = time.time()
        self.sequence = 0
        self.cycle_enabled = False
        self.unit_id = 1
        self.values = {joint_id: 0.0 for joint_id, _name, _lower, _upper in DEFAULT_JOINTS}
        self.limits = {joint_id: (lower, upper) for joint_id, _name, lower, upper in DEFAULT_JOINTS}

    def _cycle_values(self, elapsed):
        return {
            "j1": math.sin(elapsed * 0.42) * 1.1,
            "j2": -0.35 + math.sin(elapsed * 0.55) * 0.75,
            "j3": 0.55 + math.sin(elapsed * 0.67 + 0.8) * 0.85,
            "j4": math.sin(elapsed * 0.9 + 1.4) * 1.2,
            "j5": math.sin(elapsed * 0.73 + 2.1) * 1.55,
            "j6": math.sin(elapsed * 1.1) * 1.45,
        }

    def set_cycle(self, enabled):
        with self.lock:
            self.cycle_enabled = enabled
            if enabled:
                self.started_at = time.time()

    def home(self):
        with self.lock:
            self.cycle_enabled = False
            for joint_id in self.values:
                self.values[joint_id] = 0.0

    def write(self, key, value):
        with self.lock:
            joint_id = self.resolve_joint_id(key)
            if joint_id is None:
                raise ValueError(f"Unknown joint/register {key}")
            lower, upper = self.limits[joint_id]
            self.values[joint_id] = clamp(float(value), lower, upper)
            self.cycle_enabled = False
            return joint_id, self.values[joint_id]

    def resolve_joint_id(self, key):
        normalized = str(key).strip().lower()
        if normalized in self.values:
            return normalized
        if normalized.startswith("hr"):
            normalized = normalized[2:].strip()
        try:
            display = int(normalized)
        except ValueError:
            return None
        index = (display - 40101) // 2
        if display < 40101 or (display - 40101) % 2 != 0 or index < 0 or index >= len(DEFAULT_JOINTS):
            return None
        return DEFAULT_JOINTS[index][0]

    def snapshot(self):
        with self.lock:
            elapsed = time.time() - self.started_at
            if self.cycle_enabled:
                for joint_id, value in self._cycle_values(elapsed).items():
                    lower, upper = self.limits[joint_id]
                    self.values[joint_id] = clamp(value, lower, upper)
            self.sequence += 1
            sequence = self.sequence
            values = dict(self.values)
            cycle_enabled = self.cycle_enabled

        registers = []
        flat_words = []
        for index, (joint_id, joint_name, _lower, _upper) in enumerate(DEFAULT_JOINTS):
            address = 100 + index * 2
            display_address = str(40101 + index * 2)
            words = encode_f32_words(values[joint_id])
            flat_words.extend(words)
            registers.append(
                {
                    "address": address,
                    "displayAddress": display_address,
                    "signalId": f"reported_{joint_id}",
                    "jointId": joint_id,
                    "jointName": joint_name,
                    "value": values[joint_id],
                    "registers": words,
                    "dataType": "f32",
                    "byteOrder": "be",
                    "wordOrder": "high-low",
                    "area": "holding-register",
                }
            )

        request_pdu = [0x03, 0x00, 0x64, 0x00, len(flat_words)]
        response_pdu = [0x03, len(flat_words) * 2]
        for word in flat_words:
            response_pdu.extend([(word >> 8) & 0xFF, word & 0xFF])

        packets = [
            {
                "direction": "request",
                "transactionId": sequence,
                "unitId": self.unit_id,
                "functionCode": 3,
                "area": "holding-register",
                "address": 100,
                "quantity": len(flat_words),
                "bindingIds": [item["signalId"] for item in registers],
                "hex": modbus_tcp_hex(sequence, self.unit_id, request_pdu),
                "decoded": f"Read Holding Registers 40101-{40100 + len(flat_words)}",
            },
            {
                "direction": "response",
                "transactionId": sequence,
                "unitId": self.unit_id,
                "functionCode": 3,
                "area": "holding-register",
                "address": 100,
                "quantity": len(flat_words),
                "bindingIds": [item["signalId"] for item in registers],
                "hex": modbus_tcp_hex(sequence, self.unit_id, response_pdu),
                "decoded": f"{len(flat_words)} registers: {words_to_hex(flat_words)}",
            },
        ]

        return {
            "schemaVersion": 1,
            "name": "Terminal Robot Modbus Driver",
            "protocol": "modbus-tcp",
            "transport": "local-http-bridge-for-browser",
            "connectionId": "terminal-plc01",
            "unitId": self.unit_id,
            "sequence": sequence,
            "timestampUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cycleEnabled": cycle_enabled,
            "registers": registers,
            "modbusPackets": packets,
        }


class DriverHandler(BaseHTTPRequestHandler):
    state = None

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._send_json({"ok": True, "service": "terminal-robot-modbus-driver"})
            return
        if path == "/state":
            self._send_json(self.state.snapshot())
            return
        self._send_json({"error": "not-found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/cycle":
            self.state.set_cycle(True)
            self._send_json({"ok": True, "cycleEnabled": True})
            return
        if path == "/home":
            self.state.home()
            self._send_json({"ok": True, "cycleEnabled": False})
            return
        if path != "/write":
            self._send_json({"error": "not-found"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            key = payload.get("displayAddress") or payload.get("jointId") or payload.get("signalId")
            value = float(payload["value"])
            joint_id, applied = self.state.write(key, value)
            self._send_json({"ok": True, "jointId": joint_id, "value": applied})
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, 400)

    def log_message(self, _format, *_args):
        return


def start_server(state, host, port):
    DriverHandler.state = state
    server = ThreadingHTTPServer((host, port), DriverHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def print_status(state):
    snapshot = state.snapshot()
    print(f"sequence={snapshot['sequence']} cycle={snapshot['cycleEnabled']} protocol={snapshot['protocol']}")
    for item in snapshot["registers"]:
        print(f"  HR {item['displayAddress']} {item['jointId']:>2} {item['value']:>7.3f} words={words_to_hex(item['registers'])}")


def repl(state):
    print("Commands: cycle | stop | home | status | set <HR|joint> <value> | j1 <value> ... j6 <value> | quit")
    while True:
        try:
            raw = input("modbus> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not raw:
            continue
        parts = raw.split()
        command = parts[0].lower()
        try:
            if command in {"quit", "exit"}:
                return
            if command == "cycle":
                state.set_cycle(True)
                print("cycle enabled")
            elif command == "stop":
                state.set_cycle(False)
                print("cycle stopped")
            elif command == "home":
                state.home()
                print("home applied")
            elif command == "status":
                print_status(state)
            elif command == "set" and len(parts) == 3:
                joint_id, applied = state.write(parts[1], float(parts[2]))
                print(f"{joint_id}={applied:.3f}")
            elif command in state.values and len(parts) == 2:
                joint_id, applied = state.write(command, float(parts[1]))
                print(f"{joint_id}={applied:.3f}")
            else:
                print("Unknown command. Use: set 40103 0.8, j2 -0.4, cycle, home, status, quit")
        except Exception as exc:
            print(f"error: {exc}")


def self_test():
    state = RobotModbusState()
    state.write("40103", 1.25)
    snapshot = state.snapshot()
    registers = snapshot["registers"]
    assert registers[1]["jointId"] == "j2"
    assert abs(registers[1]["value"] - 1.25) < 0.0001
    assert len(registers[1]["registers"]) == 2
    assert snapshot["modbusPackets"][0]["functionCode"] == 3
    assert snapshot["modbusPackets"][0]["hex"].startswith("00 01 00 00")
    assert "0x" in snapshot["modbusPackets"][1]["decoded"]
    print("modbus robot driver self-test passed")


def main():
    parser = argparse.ArgumentParser(description="Terminal Modbus robot driver for 3D Asset Platform Digital Twin Scenario.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--cycle", action="store_true", help="Start with automatic robot movement enabled.")
    parser.add_argument("--no-repl", action="store_true", help="Run server without interactive terminal commands.")
    parser.add_argument("--duration", type=float, default=0.0, help="Stop automatically after this many seconds when --no-repl is used.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
      self_test()
      return

    state = RobotModbusState()
    state.set_cycle(args.cycle)
    server = start_server(state, args.host, args.port)
    print(f"Terminal Modbus robot driver listening on http://{args.host}:{args.port}")
    print("Open Digital Twin Scenario, select a robot, then press Terminal Bridge.")
    try:
        if args.no_repl:
            started = time.time()
            while args.duration <= 0 or time.time() - started < args.duration:
                time.sleep(0.2)
        else:
            repl(state)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
