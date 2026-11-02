#!/usr/bin/env python3
"""
##############################################################################
#                                                                            #
#   EMERGENCY ONLY.  FOR A PERSON AT A TERMINAL.  AGENTS MUST NEVER RUN      #
#   THIS SCRIPT.                                                             #
#                                                                            #
#   Thaws frozen scripts on the GemStone IV DEVELOPMENT server (GS4D) with   #
#   `/freeze thaw script <id>`, many at once. A frozen script can't be       #
#   rolled in or out.                                                        #
#                                                                            #
#   No agent (Claude Code, Codex, a subagent, ...) may run, wrap,            #
#   import-and-call or otherwise drive this script, even if asked or         #
#   "approved" by another agent.                                             #
#                                                                            #
##############################################################################

Usage: tools/emergency/emergency_dev_thaw.py 12345 S12346 S12347.gsl [...] [--file ids.txt]

Scripts are given as bare numbers, S#####, or S#####.gsl file names/paths (only the number is used; the file needn't
exist), and with --file as a file of ids separated by whitespace or commas. They are normalized and deduplicated.

Its safety envelope lives in this file, and nothing imports it: agent-environment, parent-process and TTY guards,
the emergency uploader's credentials (the account, devInstance and the one Dev character, from devCharacters or
devCharacter as the Dev upload tool reads them, in ~/.gsl/loginConfig.upload.json; the password from GSL_PASSWORD
if set, otherwise a hidden prompt after the typed phrase; never printed or logged), always GS4D, refused unless
EAccess reports GS4D as DEVELOPMENT (the launch reply's GAMECODE is the game family, "GS" on Prime too, so it isn't
used). These guards are best effort against a determined agent; the rule that agents never run this is the real
barrier.

The login and session mirror GSL-Editor (gsl/eaccessClient.ts, gsl/serverConnection.ts). Standard library only.

Flow: print the scripts, one typed `thaw N on dev` confirms them all (nothing is sent to the game before it; the
login comes after it), then `/freeze thaw script <id>` for each in turn, checking each reply (REPLY PATTERNS below,
observed on Dev on 2026-10-25). "Thawing script N." is thawed; "Script N was not found with a FROZEN or LOCKED
status." is not frozen (fine, counted separately); "You can only THAW a resource that you FROZE, or which was FROZEN
by a lower accessed GM." is not permitted (counted separately, the run carries on). Unrelated game text is ignored.
A Usage block stops the run, and so does anything else after REPLY_TIMEOUT without a recognised line (a stray prompt
before the verdict is skipped). A stop prints the scrubbed raw reply. Thawing an unfrozen script is harmless, so a
stopped run can simply be re-run.

Auditing: every attempt (script, result, scrubbed raw reply) is appended as a JSON line to dev-thaw-audit.log beside
the login config.

Exit status: 0 every script thawed or was not frozen; 1 a thaw was not permitted, a thaw or the login failed;
2 refused (guard, bad id, config or confirmation).
"""

import argparse
import collections
import datetime
import getpass
import json
import os
import re
import socket
import ssl
import sys
import time
import traceback

DEV_GAME_CODE = "GS4D"  # fixed: never a flag
EACCESS_HOST = "eaccess.play.net"
EACCESS_PORT = 7910
# SubjectPublicKeyInfo of the EAccess certificate, pinned exactly as GSL-Editor pins it (eaccessClient.ts).
EACCESS_PUBKEY_HEX = (
    "30820222300d06092a864886f70d01010105000382020f003082020a0282020100f72033aa4cab5cf91996664bf78ac04fb6a283f2b7"
    "13ca35852f321acd89cded91a644c1ad0531404f1e2e832d5688b8a1f6950ea3ce16e4cee23306656f3c500143e245f5f753bc68c1ee"
    "4bbb30c74b1a96cf29649209a47425fd2bc268378167b8859432e3238bb7ff718ede2ff165a1bea914c0fd53b3590ef569607d391679"
    "f42c0b1a2b40cab4f726b39f8458d87eb988138d96da54cc9800f4c437c461d0da51f0258da84accea46edfb8341ab328c22b2447d24"
    "a04078645cafabdfb3be777ae99a0c851493e57c51e5c3110abad761779cf431657f163fa1736a74a44c72eb20c93580e023e88c6ace"
    "5a628c2d3a01f1dac5fea4691c098801900ca10268428dad0d97f4c46ce824b274afc062d6b9f73e4c5f3d09930623b52645d7b3fd82"
    "9cd0347fce18c500fb0cbabf3024eb69b3d66e798a93a89f52bf0468453f0d973d2affcf75b7b3fdeeb67ffbd0b5015245b6e229df33"
    "381aeb2a77146a02c815ae0666b18ec53ed8bc74d4c372fd5952216dfc57c7184c895dbb7ba180ebd420c05f5eca45c73714af576828"
    "73e153652c60986c28cc74f22a4cfe0ce317666b66c13336b8366af5aa2a033b6ef06bdcc18927b732c920b549b5701999ede0df1a9a"
    "e633383814a63758404741020dcae87d50d7ea2228e00223f0e0637b8c2a55dd81f798f44f1ca9514a47eaf03c43e525d5574f83c91b"
    "25ccbb83110203010001"
)
FE_HELLO = "/FE:JAVA /VERSION:1.0 /P:WIN_UNKNOWN\n"
CLIENT_TIMEOUT = 15.0  # GSL-Editor's clientTimeout
TIMEOUT_MESSAGE = "timed out waiting for the server"
LOGIN_CONFIG = os.path.expanduser("~/.gsl/loginConfig.upload.json")  # the emergency uploader's: never holds a password
AUDIT_LOG = os.path.join(os.path.dirname(LOGIN_CONFIG), "dev-thaw-audit.log")  # like the Dev upload tool's default
REPLY_TIMEOUT = 10.0  # one /freeze thaw reply, up to the next prompt
EXIT_OK, EXIT_FAILED, EXIT_REFUSED = 0, 1, 2

# Environment variables Claude Code, Codex and similar agent harnesses set in their tool shells.
AGENT_ENV_VARS = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
                  "CLAUDE_PID", "AI_AGENT", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_THREAD_ID")
AGENT_ENV_PREFIXES = ("CLAUDE_CODE_",)
AGENT_PROCESS_NAMES = {"claude", "codex", "claude-code"}
AGENT_PROCESS_MARKERS = ("claude-code", "@anthropic-ai", "@openai/codex")

RX_ID = re.compile(r"^s?([0-9]{1,6})(?:\.gsl)?$", re.IGNORECASE)
RX_MODE = re.compile(r"<mode\s+id=([\"'])(?P<mode>GAME|CMGR)\1\s*/>")
RX_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]*[0-~])")

# ---------------------------------------------------------------------------------------------------------------
# REPLY PATTERNS, as observed on Dev on 2026-10-25. Each is a whole line. Other lines (blank lines, game
# notices such as "Your account has a SimuCon goodie bag to pick up!") are ignored. The thawed and not-frozen lines
# must name the script being thawed (a verdict naming another script makes the reply unknown). The not-permitted line
# names no script, so it is accepted only as the sole verdict in the reply to the current command, read after that
# command was sent and before its prompt; if that prompt never comes (timeout) the run stops. A named verdict whose
# prompt times out still counts, after the rest is drained. No verdict, two different verdicts or a Usage block stops
# the run.
RX_THAWED = re.compile(r"^Thawing script (?P<script>\d+)\.$")
RX_NOT_FROZEN = re.compile(r"^Script (?P<script>\d+) was not found with a FROZEN or LOCKED status\.$")
RX_NOT_PERMITTED = re.compile(r"^You can only THAW a resource that you FROZE, or which was FROZEN by a lower "
                              r"accessed GM\.$")
RX_USAGE = re.compile(r"^\s*Usage:")

# Verdicts that move on to the next script, and how each is printed.
OUTCOMES = {"thawed": "thawed", "not-frozen": "not frozen (nothing to do)",
            "not-permitted": "NOT PERMITTED: frozen by a higher-access GM (only they can thaw it); skipped"}
SUMMARY_PER_LINE = 8  # script labels per printed line

HELP_EPILOG = """\
EMERGENCY ONLY. FOR A PERSON AT A TERMINAL. AGENTS MUST NEVER RUN THIS SCRIPT.
Target is always GS4D (Dev), as the login config's devCharacter; you'll type `thaw N on dev` to confirm.
Audit log: dev-thaw-audit.log beside the login config
"""


class Refused(Exception):
    """A guard or validation refused to continue (exit 2)."""


class ThawError(Exception):
    def __init__(self, step, message):
        super().__init__(f"{step}: {message}")


class ServerTimeout(ThawError):
    """The server didn't answer in time."""


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------------------------------------------------------
# Guards


def agent_markers(env):
    """Names of agent-session environment variables present in env."""
    return sorted(k for k in env if k in AGENT_ENV_VARS or k.startswith(AGENT_ENV_PREFIXES))


def check_not_agent(env):
    found = agent_markers(env)
    if found:
        raise Refused("this script is for a person at a terminal and agents must never run it; agent-session "
                      f"environment variables are present ({', '.join(found)}). Run it from a plain terminal, not "
                      "from an agent.")


def _read_proc(pid):
    """(parent pid, argv list) of a process from /proc, or None."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            stat = f.read().decode("utf-8", "replace")
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = [a for a in f.read().decode("utf-8", "replace").split("\0") if a]
        with open(f"/proc/{pid}/comm", "rb") as f:
            comm = f.read().decode("utf-8", "replace").strip()
    except OSError:
        return None
    ppid = int(stat[stat.rindex(")") + 2:].split()[1])  # comm may contain spaces; fields follow the last ")"
    return ppid, argv + [comm]


def agent_ancestor(pid=None, read_proc=_read_proc):
    """Description of an ancestor process that looks like an agent harness (Claude Code, Codex), or None.
    Catches agents that clear the environment (env -i) and fake a terminal (script -c)."""
    pid = os.getppid() if pid is None else pid
    seen = set()
    while pid and pid > 1 and pid not in seen:
        seen.add(pid)
        info = read_proc(pid)
        if info is None:
            return None
        ppid, names = info
        for name in names:
            base = os.path.basename(name).lower()
            if base in AGENT_PROCESS_NAMES or any(m in name.lower() for m in AGENT_PROCESS_MARKERS):
                return f"pid {pid} ({base})"
        pid = ppid
    return None


def check_no_agent_ancestor(read_proc=_read_proc):
    found = agent_ancestor(read_proc=read_proc)
    if found:
        raise Refused(f"this script is for a person at a terminal and agents must never run it; it was started "
                      f"under an agent process ({found}). Run it from a plain terminal, not from an agent.")


def check_tty(stdin, stdout):
    def isatty(stream):
        try:
            return stream.isatty()
        except (AttributeError, ValueError):
            return False
    if not (isatty(stdin) and isatty(stdout)):
        raise Refused("stdin and stdout must both be an interactive terminal (a person types the confirmation).")


def load_credentials(env, login_config=LOGIN_CONFIG, getpass_fn=getpass.getpass):
    """Account and character from the login config, password from GSL_PASSWORD or a hidden prompt. The password is
    never printed or stored."""
    try:
        with open(login_config, encoding="utf-8") as f:
            config = json.load(f)
    except (OSError, ValueError) as e:
        raise Refused(f"can't read the GSL login config {login_config} ({type(e).__name__})") from None
    account = config.get("account")
    if not isinstance(account, str) or not account:
        raise Refused(f"no account in {login_config}")
    if config.get("devInstance") != DEV_GAME_CODE:
        raise Refused(f"{login_config}: devInstance is {config.get('devInstance')!r}, not {DEV_GAME_CODE}; "
                      "this script only ever works on GS4D")
    # As the Dev upload tool reads it (gsl/mcp/mcpConfig.ts): devCharacters wins over devCharacter, names are
    # trimmed and deduplicated without regard to case, and there must be exactly one.
    configured = config.get("devCharacters")
    if configured is None:
        configured = config.get("devCharacter")
    characters = configured if isinstance(configured, list) else [configured]
    if not characters or any(not isinstance(c, str) or not c.strip() for c in characters):
        raise Refused(f"no devCharacter in {login_config}")
    unique = {c.strip().lower(): c.strip() for c in characters}
    if len(unique) != 1:
        raise Refused(f"{login_config}: devCharacters names {len(unique)} characters; this script needs exactly one")
    character = next(iter(unique.values()))
    password = env.get("GSL_PASSWORD") or getpass_fn("Play.net password (not echoed): ")
    if not password:
        raise Refused("no password")
    return account, character, password


# ---------------------------------------------------------------------------------------------------------------
# Secret scrubbing and transcript


class Scrubber:
    def __init__(self):
        self.secrets = set()

    def add(self, value):
        if value:
            self.secrets.add(str(value))

    def __call__(self, text):
        text = str(text)
        for s in sorted(self.secrets, key=len, reverse=True):
            text = text.replace(s, "<redacted>")
        return text


class Transcript:
    """The recent exchange with the server, for failure context. Holds no secrets once scrubbed."""

    def __init__(self, scrub, limit=400):
        self.scrub = scrub
        self.entries = collections.deque(maxlen=limit)

    def recv(self, text):
        self.entries.append("S< " + text)

    def sent(self, text):
        self.entries.append("C> " + text)

    def dump(self):
        return self.scrub("\n".join(self.entries))


# ---------------------------------------------------------------------------------------------------------------
# EAccess login (gsl/eaccessClient.ts quickLogin)


def _der_header(buf, pos):
    tag = buf[pos]
    length = buf[pos + 1]
    pos += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(buf[pos:pos + n], "big")
        pos += n
    return tag, pos, length


def spki_from_cert(der):
    """SubjectPublicKeyInfo DER from an X.509 certificate DER (what Node's certificate.pubkey holds)."""
    _, pos, _ = _der_header(der, 0)  # Certificate
    _, pos, length = _der_header(der, pos)  # TBSCertificate
    end = pos + length
    fields = []
    while pos < end:
        start = pos
        tag, content, length = _der_header(der, pos)
        pos = content + length
        fields.append((tag, der[start:pos]))
    if fields and fields[0][0] == 0xA0:  # [0] version
        fields = fields[1:]
    # serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
    return fields[5][1]


def open_eaccess(timeout=CLIENT_TIMEOUT):
    """TLS connection to EAccess, with the certificate's public key pinned like GSL-Editor."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # GSL-Editor uses rejectUnauthorized: false plus the pin below
    raw = socket.create_connection((EACCESS_HOST, EACCESS_PORT), timeout=timeout)
    sock = ctx.wrap_socket(raw, server_hostname=EACCESS_HOST)
    try:
        der = sock.getpeercert(binary_form=True)
        if not der or spki_from_cert(der).hex().upper() != EACCESS_PUBKEY_HEX.upper():
            raise ThawError("login", "could not establish secure connection for authentication; bad certificate")
    except Exception:
        sock.close()
        raise
    return sock


def hash_password(password, key):
    pw = password.encode("utf-8")
    if len(key) < len(pw):
        raise ThawError("login", "EAccess hash key is shorter than the password")
    return bytes((((pw[n] - 0x20) ^ key[n]) + 0x20) & 0xFF for n in range(len(pw)))


def _fields(data):
    return re.split(r"[\t\n]", data.decode("latin-1"))


def eaccess_login(sock, account, password, character, scrub, transcript):
    """Run the EAccess exchange; return the SAL dict (gamehost, gameport, key, ...). Dev only."""
    game = DEV_GAME_CODE

    def xchg(data):
        transcript.sent("EAccess " + data[:1].decode("latin-1"))  # command letter and reply code: the rest has keys
        sock.sendall(data)
        reply = sock.recv(65536)
        if not reply:
            raise ThawError("login", "EAccess connection closed before login completed")
        transcript.recv("EAccess reply " + ("<hash key>" if data == b"K" else _fields(reply)[0][:1]))
        return reply

    key = xchg(b"K")
    scrub.add(key.decode("latin-1").strip())
    hashed = hash_password(password, key)
    reply = _fields(xchg(b"A\t" + account.encode("utf-8") + b"\t" + hashed))
    if len(reply) < 4 or reply[2] != "KEY":
        code = reply[2] if len(reply) > 2 and reply[2] in ("NORECORD", "PASSWORD") else "?"
        raise ThawError("login", f"quick login failed due to {code}")
    scrub.add(reply[3])
    games = _fields(xchg(b"M"))
    codes = [games[n].strip() for n in range(1, len(games) - 1, 2)]
    for code in codes:
        xchg(f"F\t{code}".encode())
    if game not in codes:
        raise ThawError("login", f"{game} is not in the account's game list")
    reply = _fields(xchg(f"G\t{game}".encode()))
    if reply[0] != "G":
        raise ThawError("login", f"selecting {game} failed ({reply[0]!r})")
    reply = _fields(xchg(f"N\t{game}".encode()))
    if reply[0] != "N" or len(reply) < 2:
        raise ThawError("login", f"game details for {game} failed ({reply[0]!r})")
    if reply[1].split("|")[0] != "DEVELOPMENT":
        raise ThawError("login", f"refusing: EAccess reports {game} as {reply[1].split('|')[0]!r}, not DEVELOPMENT")
    reply = _fields(xchg(b"C"))
    if reply[0] != "C":
        raise ThawError("login", f"character list failed ({reply[0]!r})")
    chars = {reply[n].strip(): reply[n + 1].strip() for n in range(5, len(reply) - 1, 2)}
    code = character if character in chars else next(
        (c for c, name in chars.items() if name.lower() == character.lower()), None)
    if code is None:
        raise ThawError("login", f"character {character!r} not found on {game}")
    reply = _fields(xchg(f"L\t{code}\tSTORM".encode()))
    if reply[0] != "L" or len(reply) < 2 or reply[1] != "OK":
        raise ThawError("login", f"launching {character} failed ({reply[0]!r})")
    sal = {}
    for item in reply[2:]:
        k, _, v = item.partition("=")
        if k:
            sal[k.lower()] = v
    if sal.get("key"):
        scrub.add(sal["key"])
    # GAMECODE in the launch reply is the game family ("GS" for Prime and Dev alike), so it can't tell Dev apart;
    # GSL-Editor doesn't check it either. Dev rests on the N reply (DEVELOPMENT, above) for the GS4D we selected.
    if not (sal.get("gamehost") and sal.get("gameport", "").isdigit() and sal.get("key")):
        raise ThawError("login", "launch reply is missing the game host, port or key")
    return sal


def open_game(host, port, timeout=CLIENT_TIMEOUT):
    return socket.create_connection((host, port), timeout=timeout)


# ---------------------------------------------------------------------------------------------------------------
# Audit


class Audit:
    def __init__(self, path, scrub):
        self.path = path
        self.scrub = scrub
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "a", encoding="utf-8"):
            pass  # fail before thawing anything if the log can't be written
        try:
            self.user = getpass.getuser()
        except Exception:  # noqa: BLE001
            self.user = str(os.getuid())
        self.host = socket.gethostname()

    def _scrubbed(self, value):
        # Scrub before JSON encoding, so escaping can't hide a secret from the match.
        if isinstance(value, str):
            return self.scrub(value)
        if isinstance(value, dict):
            return {k: self._scrubbed(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._scrubbed(v) for v in value]
        return value

    def record(self, **fields):
        rec = self._scrubbed({"ts": now(), "user": self.user, "host": self.host, "target": DEV_GAME_CODE, **fields})
        line = json.dumps(rec, sort_keys=True)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
            os.fsync(f.fileno())


# ---------------------------------------------------------------------------------------------------------------
# Script ids and thaw replies


def classify(lines, number):
    """Read a `/freeze thaw script N` reply: "thawed", "not-frozen", "not-permitted", "usage" or "unknown"."""
    if any(RX_USAGE.search(ln) for ln in lines):
        return "usage"
    found = set()
    for ln in lines:
        ln = ln.strip()
        for status, rx in (("thawed", RX_THAWED), ("not-frozen", RX_NOT_FROZEN)):
            m = rx.match(ln)
            if m:  # a verdict for another script means replies are out of step: unknown
                found.add(status if int(m.group("script")) == number else "other-script")
        if RX_NOT_PERMITTED.match(ln):
            found.add("not-permitted")
    status = found.pop() if len(found) == 1 else "unknown"
    return "unknown" if status == "other-script" else status


def parse_id(token):
    """Script number from 12345, S12345, S12345.gsl or a path to one."""
    name = os.path.basename(token.strip().rstrip("/"))
    m = RX_ID.match(name)
    if not m or int(m.group(1)) == 0:
        raise Refused(f"{token!r}: expected a script number, S#####, or S#####.gsl")
    return int(m.group(1))


def read_id_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError) as e:
        raise Refused(f"can't read --file {path} ({type(e).__name__})") from None
    return [t for t in re.split(r"[\s,]+", text) if t]


def collect_ids(tokens):
    numbers = []
    for t in tokens:
        n = parse_id(t)
        if n not in numbers:
            numbers.append(n)
    if not numbers:
        raise Refused("no script ids given")
    return numbers


def label(n):
    return f"S{n:05d}"


def confirmation_phrase(n):
    return f"thaw {n} on dev"


# ---------------------------------------------------------------------------------------------------------------
# Game session (gsl/serverConnection.ts + gsl/editorClient.ts)


FLUSH = object()  # _pump: clear the unterminated tail and keep waiting


class ThawSession:
    def __init__(self, sock, transcript):
        self.sock = sock
        self.transcript = transcript
        self.buf = ""

    def send(self, command):
        self.transcript.sent(command)
        self.sock.sendall((command + "\n").encode("utf-8"))

    def _read(self, deadline, step):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ServerTimeout(step, TIMEOUT_MESSAGE)
        self.sock.settimeout(remaining)
        try:
            data = self.sock.recv(65536)
        except socket.timeout:
            raise ServerTimeout(step, TIMEOUT_MESSAGE) from None
        if not data:
            raise ThawError(step, "the server closed the connection")
        text = data.decode("latin-1")
        self.transcript.recv(text)
        return text

    def _pump(self, on_line, on_tail, timeout, step):
        """Feed complete CRLF lines (ANSI stripped) to on_line, then the unterminated tail to on_tail, per chunk,
        like GSL-Editor's OutputProcessor. Either returns non-None to finish; on_tail may return FLUSH."""
        deadline = time.monotonic() + timeout
        while True:
            while "\r\n" in self.buf:
                line, self.buf = self.buf.split("\r\n", 1)
                result = on_line(RX_ANSI.sub("", line))
                if result is not None:
                    return result
            result = on_tail(self.buf)
            if result is FLUSH:
                self.buf = ""
            elif result is not None:
                return result
            self.buf += self._read(deadline, step)

    def handshake(self, key):
        step = "connect"
        self.transcript.sent("<session key>")
        self.sock.sendall(key.encode("latin-1") + b"\n")
        self.send(FE_HELLO.rstrip("\n"))
        deadline = time.monotonic() + CLIENT_TIMEOUT
        raw = ""
        while True:
            raw += self._read(deadline, step)
            while "\n" in raw:
                line, raw = raw.split("\n", 1)
                if RX_MODE.search(line):
                    self.buf = raw
                    self._pump(lambda line: None, lambda tail: True if tail[-1:] == ">" else None,
                               CLIENT_TIMEOUT, "wait for game prompt")
                    return

    def drain(self, quiet=0.5, limit=5.0):
        """Read and discard (into the transcript) until the server has been quiet for `quiet` seconds."""
        deadline = time.monotonic() + limit
        self.buf = ""
        while time.monotonic() < deadline:
            self.sock.settimeout(quiet)
            try:
                data = self.sock.recv(65536)
            except socket.timeout:
                return
            if not data:
                raise ThawError("drain", "the server closed the connection")
            self.transcript.recv(data.decode("latin-1"))

    def quit(self, grace=2.0):
        """Send quit, then let the server close first (like ServerConnection.closeGraceMillis), so the quit isn't
        lost to a reset and the character isn't left link-dead."""
        try:
            self.send("quit")
            self.sock.shutdown(socket.SHUT_WR)
            deadline = time.monotonic() + grace
            while time.monotonic() < deadline:
                self.sock.settimeout(max(0.05, deadline - time.monotonic()))
                if not self.sock.recv(65536):
                    break
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass

    def thaw(self, n, timeout=None):
        """`/freeze thaw script N`; returns {"lines": the reply (ANSI stripped, prompts left out), "timed_out",
        "error"}, read up to the first prompt after a verdict or Usage line (a prompt before one, e.g. after stray
        game text, is skipped). After a timeout the late reply is drained."""
        step = f"thaw (/freeze thaw script {n})"
        lines = []
        self.buf = ""

        def seen():
            return classify(lines, n) != "unknown"

        def on_line(line):
            if line.strip() == ">":
                return True if seen() else None
            lines.append(line)
            return None

        def on_tail(tail):
            if tail.rstrip()[-1:] == ">":
                return True if seen() else FLUSH  # drop the early prompt and keep reading
            return None

        self.send(f"/freeze thaw script {n}")
        try:
            self._pump(on_line, on_tail, REPLY_TIMEOUT if timeout is None else timeout, step)
        except ServerTimeout as e:
            if self.buf.strip():
                lines.append(self.buf)
            self.drain()
            return {"lines": lines, "timed_out": True, "error": str(e)}
        self.buf = ""
        return {"lines": lines, "timed_out": False}


def main(argv=None, env=None, stdin=None, stdout=None, stderr=None, input_fn=input, getpass_fn=getpass.getpass,
         open_eaccess_fn=open_eaccess, open_game_fn=open_game, login_config=LOGIN_CONFIG,
         audit_path=AUDIT_LOG, read_proc=_read_proc):
    env = os.environ if env is None else env
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr

    def out(msg):
        print(msg, file=stdout, flush=True)

    def err(msg):
        print(msg, file=stderr, flush=True)

    parser = argparse.ArgumentParser(
        prog="emergency_dev_thaw.py",
        description="EMERGENCY ONLY, for a person at a terminal: thaw frozen scripts on GS4D (Dev) with "
                    "/freeze thaw script <id>.",
        epilog=HELP_EPILOG, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ids", nargs="*", metavar="ID", help="script ids: 12345, S12345 or S12345.gsl")
    parser.add_argument("--file", metavar="PATH", help="a file of script ids separated by whitespace or commas")
    args = parser.parse_args(argv)
    if not args.ids and not args.file:
        parser.error("give at least one script id (or --file)")

    scrub = Scrubber()
    try:
        check_not_agent(env)
        check_no_agent_ancestor(read_proc)
        check_tty(stdin, stdout)
        numbers = collect_ids(list(args.ids) + (read_id_file(args.file) if args.file else []))
        audit = Audit(audit_path, scrub)
    except Refused as e:
        err(f"REFUSED: {e}")
        return EXIT_REFUSED
    except OSError as e:
        err(f"REFUSED: can't write the audit log {audit_path} ({e})")
        return EXIT_REFUSED

    n_total = len(numbers)
    out(f"EMERGENCY DEV THAW ({DEV_GAME_CODE}).")
    out(f"These {n_total} script(s) would be thawed on {DEV_GAME_CODE} with /freeze thaw script <id>:")
    for i in range(0, n_total, SUMMARY_PER_LINE):
        out("  " + "  ".join(label(n) for n in numbers[i:i + SUMMARY_PER_LINE]))

    session_id = f"{now()}-{os.getpid()}"
    results = {}

    def record(n, result, **extra):
        audit.record(event="thaw", session=session_id, script=n, result=result, **extra)

    phrase = confirmation_phrase(n_total)
    try:
        typed = input_fn(f"Type '{phrase}' to thaw all of them (anything else thaws nothing): ")
    except (EOFError, KeyboardInterrupt):
        typed = ""
    if typed.strip() != phrase:
        err("REFUSED: confirmation phrase did not match; nothing thawed (and nothing sent to the game).")
        audit.record(event="declined", session=session_id, scripts=numbers)
        return EXIT_REFUSED

    try:
        account, character, password = load_credentials(env, login_config, getpass_fn)
    except (Refused, EOFError, KeyboardInterrupt) as e:
        e = e if isinstance(e, Refused) else Refused("no password (prompt cancelled)")
        err(f"REFUSED: {e}")
        audit.record(event="refused", session=session_id, scripts=numbers, error=str(e))
        return EXIT_REFUSED
    scrub.add(password)
    scrub.add(account)

    audit.record(event="session-start", session=session_id, character=character, scripts=numbers)
    transcript = Transcript(scrub)
    session = None
    current = None
    step = "login"
    last_error = None

    def show_reply(lines, indent="         "):
        for ln in lines or ["(empty reply)"]:
            err(f"{indent}S< {scrub(ln)}")

    exit_code = EXIT_OK
    try:
        out(f"[{now()}] logging in to {DEV_GAME_CODE} as {character}")
        ea = open_eaccess_fn()
        try:
            sal = eaccess_login(ea, account, password, character, scrub, transcript)
        finally:
            try:
                ea.close()
            except OSError:
                pass
        step = "connect"
        session = ThawSession(open_game_fn(sal["gamehost"], int(sal["gameport"])), transcript)
        session.handshake(sal["key"])
        out(f"[{now()}] connected")
        session.drain(quiet=0.3)  # anything left over from the login, so it can't be read as the first reply

        for i, n in enumerate(numbers, 1):
            current = n
            step = f"thaw (/freeze thaw script {n})"
            reply = session.thaw(n)
            # A timeout with a reply in hand means the reply was never recognised (or its prompt never came).
            status = classify(reply["lines"], n) if reply["lines"] or not reply["timed_out"] else "timeout"
            if status == "not-permitted" and reply["timed_out"]:
                status = "unknown"  # it names no script: only trust it inside a complete reply
            if status in OUTCOMES:
                results[n] = status
                record(n, status, reply=reply["lines"])
                out(f"[{now()}] {i}/{n_total}  {label(n)}  {OUTCOMES[status]}")
                if status == "not-permitted":
                    exit_code = EXIT_FAILED  # carry on, but it wasn't thawed
                continue
            why = {"timeout": f"no reply ({reply.get('error')}); outcome unknown: check with /freeze list script {n}",
                   "usage": "the server printed its Usage text (command not accepted)",
                   }.get(status, "reply not recognised; outcome unknown: check with /freeze list script "
                                 f"{n}")
            results[n] = "failed"
            record(n, "failed", reply=reply["lines"], error=why)
            last_error = f"{label(n)}: {why}"
            err(f"[{now()}] STOPPED at {i}/{n_total}  {label(n)}: {why}")
            err("         reply (credentials redacted):")
            show_reply(reply["lines"])
            exit_code = EXIT_FAILED
            break
        current = None
    except (Exception, KeyboardInterrupt) as e:  # noqa: BLE001 - report every failure with full context
        exit_code = EXIT_FAILED
        interrupted = isinstance(e, KeyboardInterrupt)
        if interrupted:
            e = ThawError(step, "interrupted (Ctrl+C)").with_traceback(e.__traceback__)
        last_error = f"{step}: {e}"
        err("=" * 78)
        err(f"[{now()}] FAILED at step: {step}")
        err(f"  error: {scrub(e)}")
        err("  traceback:")
        err(scrub("".join(traceback.format_exception(type(e), e, e.__traceback__))))
        err("  server transcript (most recent last, credentials redacted):")
        err(transcript.dump() or "  (empty)")
        err("=" * 78)
        if current is not None and current not in results:
            results[current] = "interrupted" if interrupted else "error"
            record(current, results[current],
                   error=f"{last_error}; outcome unknown: check with /freeze list script {current}")
    finally:
        if session is not None:
            try:
                session.quit()
            except KeyboardInterrupt:  # still write the closing audit records below
                pass

    for n in numbers:
        if n not in results:
            results[n] = "not-attempted"
            record(n, "not-attempted", error="stopped before this script" + (f" ({last_error})" if last_error else ""))
    audit.record(event="session-end", session=session_id, results={str(k): v for k, v in results.items()})

    def listed(kind):
        return [label(n) for n in numbers if results[n] == kind]

    out("")
    out("Summary:")
    for kind, title in (("thawed", "thawed"), ("not-frozen", "not frozen (skipped)"),
                        ("not-permitted", "not permitted (frozen by a higher-access GM)"),
                        ("failed", "failed"), ("error", "error (outcome unknown)"),
                        ("interrupted", "interrupted (outcome unknown)"), ("not-attempted", "not attempted")):
        names = listed(kind)
        if names or kind in ("thawed", "not-frozen", "not-permitted", "failed"):
            out(f"  {title}: {len(names)}")
            if kind != "thawed":
                # Our own short lines, so a terminal never soft-wraps them (its copy can drop the space at a wrap).
                for i in range(0, len(names), SUMMARY_PER_LINE):
                    out("    " + " ".join(names[i:i + SUMMARY_PER_LINE]))
    out(f"Audit log: {audit.path}")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
