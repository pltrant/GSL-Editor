"""Unit tests for tools/emergency/emergency_dev_thaw.py. Run: python3 -B -m unittest discover -s tools/emergency/tests

Never touches a real game server: EAccess and the game are fake servers on socketpairs. The EAccess fake replays the
exchange GSL-Editor expects (gsl/eaccessClient.ts); the game fake answers /freeze thaw with the replies observed on
Dev on 2026-10-25.
"""

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import emergency_dev_thaw as thaw  # noqa: E402

ACCOUNT = "TESTACCT"
CHARACTER = "Someone"
PASSWORD = "Sup3r-Secret\"pw\\x"  # quote and backslash: must be scrubbed even inside JSON
EA_KEY = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef"
SESSION_KEY = "sesskey0123456789"
GAME_KEY = "gamekey9876543210abc"
THAW_SCRIPT = os.path.join(os.path.dirname(HERE), "emergency_dev_thaw.py")
USAGE = "Usage:\r\n/FREEZE ...\r\n"
NOT_PERMITTED = "You can only THAW a resource that you FROZE, or which was FROZEN by a lower accessed GM."
NOISE = "Your account has a SimuCon goodie bag to pick up!  Use SIMUCON for more information."


class TTY(io.StringIO):
    def isatty(self):
        return True


class FakeEAccess(threading.Thread):
    # GAMECODE=GS and the field set mirror what Dev's real launch reply carried on the first real run.
    def __init__(self, env="DEVELOPMENT", character=CHARACTER, host="fakehost", port=4901):
        super().__init__(daemon=True)
        self.client, self.server = socket.socketpair()
        self.env, self.character = env, character
        self.host, self.port = host, port
        self.received = []
        self.start()

    def run(self):
        s = self.server
        try:
            while True:
                data = s.recv(65536)
                if not data:
                    return
                self.received.append(data)
                cmd = data.split(b"\t")[0]
                if data == b"K":
                    s.sendall(EA_KEY)
                elif cmd == b"A":
                    ok = data.split(b"\t", 2)[2] == thaw.hash_password(PASSWORD, EA_KEY)
                    s.sendall(f"A\t{ACCOUNT}\tKEY\t{SESSION_KEY}\towner\n".encode() if ok
                              else b"A\t\tPASSWORD\n")
                elif data == b"M":
                    s.sendall(b"M\tGS3\tGemStone IV\tGS4D\tGemStone IV Development\n")
                elif cmd == b"F":
                    s.sendall(b"F\tNORMAL\n")
                elif cmd == b"G":
                    s.sendall(b"G\tGemStone IV Development\tNORMAL\n")
                elif cmd == b"N":
                    s.sendall(f"N\t{self.env}|STORM\n".encode())
                elif data == b"C":
                    s.sendall(f"C\t2\t5\t0\t0\tW_X_001\tOtherchar\tW_X_002\t{self.character}\n".encode())
                elif cmd == b"L":
                    s.sendall((f"L\tOK\tUPPORT=5535\tGAME=STORM\tGAMECODE=GS\tFULLGAMENAME=Dev\t"
                               f"GAMEFILE=STORM.EXE\tGAMEHOST={self.host}\tGAMEPORT={self.port}\t"
                               f"KEY={GAME_KEY}\n").encode())
                else:
                    s.sendall(b"?\n")
        except OSError:
            return


class FakeThawGame(threading.Thread):
    """Answers `/freeze thaw script N` per replies: N -> thawed (default), notfrozen, usage, weird, wrongnum, none
    (no reply), leak (a line with the credentials, then thawed) or close."""

    def __init__(self, replies=None, chunk=None):
        super().__init__(daemon=True)
        self.client, self.server = socket.socketpair()
        self.replies = replies or {}
        self.chunk = chunk
        self.lines = []
        self.start()

    def send(self, text):
        data = text.encode("latin-1")
        step = self.chunk or len(data)
        for i in range(0, len(data), step):
            self.server.sendall(data[i:i + step])
            if self.chunk:
                time.sleep(0.001)

    def run(self):
        buf = ""
        try:
            while True:
                data = self.server.recv(65536)
                if not data:
                    return
                buf += data.decode("utf-8")
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    self.lines.append(line)
                    if len(self.lines) == 2:  # key, then the FE hello
                        self.send('<settings/>\n<mode id="GAME"/>\nWelcome to the game.\r\n>')
                    elif line.startswith("/freeze thaw script "):
                        n = int(line.rsplit(" ", 1)[1])
                        kind = self.replies.get(n, "thawed")
                        if kind == "thawed":
                            self.send(f"Thawing script {n}.\r\n>")
                        elif kind == "notfrozen":
                            self.send(f"Script {n} was not found with a FROZEN or LOCKED status.\r\n>")
                        elif kind == "usage":
                            self.send(USAGE + ">")
                        elif kind == "weird":
                            self.send(f"Something odd happened to script {n}.\r\n>")
                        elif kind == "wrongnum":
                            self.send(f"Thawing script {n + 1}.\r\n>")
                        elif kind == "stray":  # game text and a prompt before the real reply
                            self.send("Someone waves.\r\n>")
                            time.sleep(0.05)
                            self.send(f"Thawing script {n}.\r\n>")
                        elif kind == "notpermitted":  # as Dev printed it on 2026-10-25
                            self.send(f"{NOT_PERMITTED}\r\n\r\n\r\n{NOISE}\r\n\r\n>")
                        elif kind == "notpermitted_noprompt":
                            self.send(f"{NOT_PERMITTED}\r\n")
                        elif kind == "noisy":
                            self.send(f"{NOISE}\r\n\r\n>")
                            time.sleep(0.02)
                            self.send(f"Thawing script {n}.\r\n\r\n{NOISE}\r\n>")
                        elif kind == "noiseonly":
                            self.send(f"\r\n{NOISE}\r\n\r\n>")
                        elif kind == "partial":  # starts a reply, never finishes it
                            self.send("Thawing scr")
                        elif kind == "leak":
                            self.send(f"Weird: {PASSWORD} {GAME_KEY} {ACCOUNT}\r\nThawing script {n}.\r\n>")
                        elif kind == "close":
                            self.server.close()
                            return
                    elif line == "quit":
                        self.server.close()
                        return
        except OSError:
            return


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.audit = os.path.join(self.dir, "state", "audit.log")
        self.login = os.path.join(self.dir, "loginConfig.upload.json")
        with open(self.login, "w") as f:
            json.dump({"account": ACCOUNT, "devInstance": "GS4D", "devCharacter": CHARACTER}, f)
        self.fakes = []

    def tearDown(self):
        for fake in self.fakes:
            for sock in (fake.client, fake.server):
                sock.close()
        self.tmp.cleanup()

    def audit_records(self):
        if not os.path.exists(self.audit):
            return []
        with open(self.audit) as f:
            return [json.loads(line) for line in f]

    def all_output(self):
        audit = ""
        if os.path.exists(self.audit):
            with open(self.audit) as f:
                audit = f.read()
        return self.out.getvalue() + self.err.getvalue() + audit

    def run_main(self, ids, answers=("thaw {n} on dev",), env=None, game=None, ea=None, stdin=None, n=None):
        self.out, self.err = TTY(), io.StringIO()
        n = len(set(ids)) if n is None else n
        self.ea = ea or FakeEAccess()
        self.game = game
        self.fakes += [f for f in (self.ea, game) if f is not None]
        self.opened = []
        self.prompts = []
        answers = iter([a.format(n=n) for a in answers])

        def answer(prompt=""):
            self.prompts.append(prompt)
            return next(answers)

        def open_game(host, port):
            self.opened.append((host, port))
            return self.game.client
        env = {"GSL_PASSWORD": PASSWORD} if env is None else env
        return thaw.main(ids, env=env, stdin=stdin or TTY(), stdout=self.out, stderr=self.err, input_fn=answer,
                         getpass_fn=lambda p: self.fail("unexpected password prompt"),
                         open_eaccess_fn=lambda: self.ea.client, open_game_fn=open_game,
                         login_config=self.login, audit_path=self.audit, read_proc=lambda pid: None)

    def thaws(self):
        return [l for l in self.game.lines if l.startswith("/freeze")]

    def results(self):
        return {r["script"]: r["result"] for r in self.audit_records() if r["event"] == "thaw"}


class GuardTests(Env):
    def assertRefusedBeforeNetwork(self, code):
        self.assertEqual(code, thaw.EXIT_REFUSED)
        self.assertEqual(self.ea.received, [])
        self.assertEqual(self.opened, [])

    def test_agent_env_refused(self):
        for var in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AI_AGENT", "CODEX_THREAD_ID", "CLAUDE_CODE_NEW_THING"):
            code = self.run_main(["12345"], env={var: "1"}, answers=())
            self.assertRefusedBeforeNetwork(code)
            self.assertIn("agents must never run it", self.err.getvalue())
            self.assertEqual(self.prompts, [])

    def test_unrelated_env_vars_are_not_agent_markers(self):
        self.assertEqual(thaw.agent_markers({"TERM_PROGRAM": "x", "EDITOR_SESSION": "y", "CLAUDE": "z"}), [])

    def test_agent_ancestor_refused(self):
        parent = {os.getppid(): (1, ["node", "/x/@anthropic-ai/claude-code/cli.js"])}
        self.out, self.err = TTY(), io.StringIO()
        code = thaw.main(["1"], env={}, stdin=TTY(), stdout=self.out, stderr=self.err,
                         input_fn=lambda p="": self.fail("prompted"), open_eaccess_fn=lambda: self.fail("network"),
                         login_config=self.login, audit_path=self.audit, read_proc=lambda pid: parent.get(pid))
        self.assertEqual(code, thaw.EXIT_REFUSED)
        self.assertIn("started under an agent process", self.err.getvalue())

    def test_no_tty_refused(self):
        code = self.run_main(["12345"], stdin=io.StringIO("thaw 1 on dev\n"), answers=())
        self.assertRefusedBeforeNetwork(code)
        self.assertIn("interactive terminal", self.err.getvalue())

    def test_bad_ids_refused(self):
        for bad in ("abc", "S0", "0", "1234567", "S12a", "notes.gsl", "S123.txt", "-5", "", "１２３", "S١٢٣"):
            with self.subTest(bad=bad):
                self.assertRefusedBeforeNetwork(self.run_main([bad], answers=()))

    def test_real_process_env_from_this_agent_session_is_refused(self):
        # The real script in a subprocess with this shell's environment: refused at the env guard, no network.
        if not thaw.agent_markers(os.environ):
            self.skipTest("not running inside an agent session")
        r = subprocess.run([sys.executable, THAW_SCRIPT, "12345"], capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, thaw.EXIT_REFUSED)
        self.assertIn("agents must never run it", r.stderr)

    def test_real_env_cleared_run_from_this_agent_is_refused(self):
        if not thaw.agent_ancestor():
            self.skipTest("no agent ancestor in this process tree")
        r = subprocess.run([sys.executable, THAW_SCRIPT, "12345"], capture_output=True, text=True, timeout=30,
                           stdin=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(r.returncode, thaw.EXIT_REFUSED)
        self.assertIn("started under an agent process", r.stderr)

    def test_wrong_confirmation_sends_nothing(self):
        for answer in ("thaw 2 on dev", "yes", "thaw 1 on prime", ""):
            game = FakeThawGame()
            # No GSL_PASSWORD, so a password prompt before the phrase would fail the test.
            code = self.run_main(["12345"], answers=(answer,), game=game, env={})
            self.assertRefusedBeforeNetwork(code)
            self.assertIn("confirmation phrase did not match", self.err.getvalue())
            self.assertEqual(game.lines, [])
            self.assertEqual(self.audit_records()[-1]["event"], "declined")

    def test_ctrl_c_at_confirmation_sends_nothing(self):
        self.out, self.err = TTY(), io.StringIO()

        def interrupt(prompt=""):
            raise KeyboardInterrupt
        code = thaw.main(["1"], env={}, stdin=TTY(), stdout=self.out, stderr=self.err, input_fn=interrupt,
                         getpass_fn=lambda p="": self.fail("prompted"), open_eaccess_fn=lambda: self.fail("network"),
                         login_config=self.login, audit_path=self.audit, read_proc=lambda pid: None)
        self.assertEqual(code, thaw.EXIT_REFUSED)
        self.assertEqual([r["event"] for r in self.audit_records()], ["declined"])

    def test_ctrl_c_at_password_prompt_sends_nothing(self):
        self.out, self.err = TTY(), io.StringIO()

        def interrupt(prompt=""):
            raise KeyboardInterrupt
        code = thaw.main(["1"], env={}, stdin=TTY(), stdout=self.out, stderr=self.err,
                         input_fn=lambda p="": "thaw 1 on dev", getpass_fn=interrupt,
                         open_eaccess_fn=lambda: self.fail("network"), login_config=self.login,
                         audit_path=self.audit, read_proc=lambda pid: None)
        self.assertEqual(code, thaw.EXIT_REFUSED)
        self.assertIn("prompt cancelled", self.err.getvalue())
        self.assertEqual([r["event"] for r in self.audit_records()], ["refused"])

    def test_password_prompt_follows_the_phrase_and_precedes_any_network(self):
        self.out, self.err = TTY(), io.StringIO()
        self.ea, game = FakeEAccess(), FakeThawGame()
        self.fakes += [self.ea, game]
        order = []

        def phrase(prompt=""):
            order.append("phrase")
            return "thaw 1 on dev"

        def password(prompt=""):
            order.append("password")
            self.assertEqual((self.ea.received, game.lines), ([], []))
            return PASSWORD
        code = thaw.main(["1"], env={}, stdin=TTY(), stdout=self.out, stderr=self.err, input_fn=phrase,
                         getpass_fn=password, open_eaccess_fn=lambda: self.ea.client,
                         open_game_fn=lambda host, port: game.client, login_config=self.login,
                         audit_path=self.audit, read_proc=lambda pid: None)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(order, ["phrase", "password"])

    def test_non_dev_login_config_refused(self):
        with open(self.login, "w") as f:
            json.dump({"account": ACCOUNT, "devInstance": "GS3"}, f)
        self.assertRefusedBeforeNetwork(self.run_main(["12345"], game=FakeThawGame()))

    def test_no_target_option_exists(self):
        with self.assertRaises(SystemExit):
            thaw.main(["--instance", "GS3", "1"], env={}, stdout=TTY(), stderr=io.StringIO())
        self.assertEqual(thaw.DEV_GAME_CODE, "GS4D")

    def test_production_game_refused_at_login(self):
        game = FakeThawGame()
        code = self.run_main(["12345"], game=game, ea=FakeEAccess(env="PRODUCTION"))
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("not DEVELOPMENT", self.err.getvalue())
        self.assertEqual(self.opened, [])
        self.assertEqual(self.results(), {12345: "not-attempted"})

    def test_character_not_found_never_launches(self):
        ea = FakeEAccess(character="Someoneelse")
        code = self.run_main(["1"], game=FakeThawGame(), ea=ea)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn(f"character {CHARACTER!r} not found", self.err.getvalue())
        self.assertNotIn(b"L", [d.split(b"\t")[0] for d in ea.received])
        self.assertEqual(self.opened, [])

    def test_login_config_without_dev_character_refused(self):
        for config in ({}, {"devCharacter": ""}, {"devCharacters": []}, {"devCharacters": [" "]},
                       {"devCharacters": [CHARACTER, 5]}, {"devCharacters": [], "devCharacter": CHARACTER}):
            with self.subTest(config=config):
                with open(self.login, "w") as f:
                    json.dump({"account": ACCOUNT, "devInstance": "GS4D", **config}, f)
                self.assertRefusedBeforeNetwork(self.run_main(["12345"], game=FakeThawGame()))
                self.assertIn("no devCharacter", self.err.getvalue())

    def test_dev_characters_list_is_read_like_the_upload_tool(self):
        # devCharacters wins over devCharacter; one name, trimmed, in any case; duplicates collapse to the last.
        with open(self.login, "w") as f:
            json.dump({"account": ACCOUNT, "devInstance": "GS4D", "devCharacter": "Otherchar",
                       "devCharacters": [CHARACTER.upper(), f" {CHARACTER} "]}, f)
        acct, char, pw = thaw.load_credentials({"GSL_PASSWORD": PASSWORD}, self.login)
        self.assertEqual((acct, char, pw), (ACCOUNT, CHARACTER, PASSWORD))
        with open(self.login, "w") as f:  # a null list falls through to devCharacter, as the upload tool's does
            json.dump({"account": ACCOUNT, "devInstance": "GS4D", "devCharacter": CHARACTER, "devCharacters": None}, f)
        self.assertEqual(thaw.load_credentials({"GSL_PASSWORD": PASSWORD}, self.login)[1], CHARACTER)
        game = FakeThawGame()
        self.assertEqual(self.run_main(["1"], game=game), thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(self.ea.received[-1], b"L\tW_X_002\tSTORM")

    def test_two_dev_characters_refused(self):
        with open(self.login, "w") as f:
            json.dump({"account": ACCOUNT, "devInstance": "GS4D", "devCharacters": [CHARACTER, "Otherchar"]}, f)
        self.assertRefusedBeforeNetwork(self.run_main(["12345"], game=FakeThawGame()))
        self.assertIn("exactly one", self.err.getvalue())

    def test_help_says_emergency_and_agents_never_run(self):
        out = io.StringIO()
        with self.assertRaises(SystemExit), mock.patch.object(sys, "stdout", out):
            thaw.main(["--help"])
        self.assertIn("EMERGENCY ONLY", out.getvalue())
        self.assertIn("AGENTS MUST NEVER RUN", out.getvalue())


class AncestorTests(unittest.TestCase):
    def tree(self, procs):
        return lambda pid: procs.get(pid)

    def test_claude_ancestor_found(self):
        procs = {10: (9, ["bash"]), 9: (8, ["script", "-qc", "x"]), 8: (1, ["/usr/bin/claude", "claude"])}
        self.assertIn("claude", thaw.agent_ancestor(10, self.tree(procs)))
        procs[8] = (1, ["node", "/home/a/.npm/lib/node_modules/@anthropic-ai/claude-code/cli.js", "node"])
        self.assertIsNotNone(thaw.agent_ancestor(10, self.tree(procs)))
        procs[8] = (1, ["codex", "codex"])
        self.assertIsNotNone(thaw.agent_ancestor(10, self.tree(procs)))

    def test_plain_terminal_passes(self):
        procs = {10: (9, ["-bash", "bash"]), 9: (8, ["/init", "init"]), 8: (1, ["/init", "init"])}
        self.assertIsNone(thaw.agent_ancestor(10, self.tree(procs)))


class LoginTests(Env):
    def test_eaccess_flow_and_game_handshake(self):
        game = FakeThawGame()
        self.assertEqual(self.run_main(["1"], game=game), thaw.EXIT_OK, self.err.getvalue())
        # EAccess flow as GSL-Editor: K, A, M, F per game, G, N, C, L as the config's character's code
        cmds = [d.split(b"\t")[0] for d in self.ea.received]
        self.assertEqual(cmds, [b"K", b"A", b"M", b"F", b"F", b"G", b"N", b"C", b"L"])
        self.assertEqual(self.ea.received[-1], b"L\tW_X_002\tSTORM")
        self.assertEqual(game.lines[:2], [GAME_KEY, thaw.FE_HELLO.strip()])

    def test_password_env_wins_and_prompt_fallback(self):
        acct, char, pw = thaw.load_credentials({"GSL_PASSWORD": "fromenv"}, self.login,
                                               lambda p: self.fail("unexpected password prompt"))
        self.assertEqual((acct, char, pw), (ACCOUNT, CHARACTER, "fromenv"))
        self.assertEqual(thaw.load_credentials({}, self.login, lambda p: "typed")[2], "typed")

    def test_empty_password_refused(self):
        with self.assertRaises(thaw.Refused):
            thaw.load_credentials({"GSL_PASSWORD": ""}, self.login, lambda p: "")

    def test_only_the_upload_login_config_is_read(self):
        self.assertEqual(thaw.LOGIN_CONFIG, os.path.expanduser("~/.gsl/loginConfig.upload.json"))
        with mock.patch("builtins.open", wraps=open) as opened:
            thaw.load_credentials({"GSL_PASSWORD": "fromenv"}, self.login)
        self.assertEqual([call.args[0] for call in opened.call_args_list], [self.login])

    def test_login_failure_transcript_has_eaccess_steps_only(self):
        self.run_main(["5"], game=FakeThawGame(), env={"GSL_PASSWORD": "wrong-password-123"})
        err = self.err.getvalue()
        self.assertIn("C> EAccess A", err)
        self.assertIn("S< EAccess reply <hash key>", err)
        self.assertNotIn(EA_KEY.decode(), err)


class UnitTests(unittest.TestCase):
    def test_hash_password(self):
        self.assertEqual(thaw.hash_password("ab", b"\x01\x02"), bytes([((0x61 - 0x20) ^ 1) + 0x20,
                                                                      ((0x62 - 0x20) ^ 2) + 0x20]))

    def test_spki_extraction_from_real_cert(self):
        with tempfile.TemporaryDirectory() as d:
            key, crt = os.path.join(d, "k.pem"), os.path.join(d, "c.der")
            try:
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
                                "-outform", "DER", "-out", crt, "-days", "1", "-subj", "/CN=test"],
                               check=True, capture_output=True, timeout=60)
                spki = subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER"],
                                      check=True, capture_output=True, timeout=60).stdout
            except (OSError, subprocess.SubprocessError):
                self.skipTest("openssl not available")
            with open(crt, "rb") as f:
                self.assertEqual(thaw.spki_from_cert(f.read()), spki)

    def test_pinned_key_is_an_rsa_spki(self):
        self.assertTrue(thaw.EACCESS_PUBKEY_HEX.startswith("30820222300d06092a864886f70d010101"))


class IdTests(unittest.TestCase):
    def test_forms(self):
        for token in ("12345", "S12345", "s12345", "S12345.gsl", "s12345.GSL", "/x/y/S12345.gsl", "012345",
                      "S012345.gsl"):
            self.assertEqual(thaw.parse_id(token), 12345, token)
        self.assertEqual(thaw.parse_id("S01276"), 1276)

    def test_dedupe_keeps_order(self):
        self.assertEqual(thaw.collect_ids(["S2", "1", "2.gsl", "S00001", "3"]), [2, 1, 3])

    def test_id_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ids.txt")
            with open(path, "w") as f:
                f.write("S1 2\n3,S4.gsl\t\n\n")
            self.assertEqual(thaw.read_id_file(path), ["S1", "2", "3", "S4.gsl"])
            with self.assertRaises(thaw.Refused):
                thaw.read_id_file(os.path.join(d, "missing.txt"))

    def test_classify(self):
        self.assertEqual(thaw.classify(["Thawing script 23050."], 23050), "thawed")
        self.assertEqual(thaw.classify(["Script 23050 was not found with a FROZEN or LOCKED status."], 23050),
                         "not-frozen")
        self.assertEqual(thaw.classify(["Usage:", "/FREEZE ..."], 23050), "usage")
        self.assertEqual(thaw.classify(["Thawing script 23051."], 23050), "unknown")
        self.assertEqual(thaw.classify(["Thawing script 23050.", "Usage:"], 23050), "usage")
        self.assertEqual(thaw.classify([], 23050), "unknown")
        self.assertEqual(thaw.classify(["Something else."], 23050), "unknown")
        self.assertEqual(thaw.classify(["Thawing script 23050.",
                                        "Script 23050 was not found with a FROZEN or LOCKED status."], 23050),
                         "unknown")
        self.assertEqual(thaw.classify(["Someone waves.", "Thawing script 1276."], 1276), "thawed")


class FlowTests(Env):
    def test_thaws_each_and_counts_not_frozen_separately(self):
        game = FakeThawGame({2: "notfrozen"})
        code = self.run_main(["S1", "2", "S00003.gsl", "1"], game=game, n=3)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(len(self.prompts), 1)
        self.assertIn("'thaw 3 on dev'", self.prompts[0])
        self.assertEqual(self.thaws(), ["/freeze thaw script 1", "/freeze thaw script 2", "/freeze thaw script 3"])
        self.assertEqual(game.lines[0], GAME_KEY)
        self.assertEqual(game.lines[-1], "quit")
        self.assertEqual(self.opened, [("fakehost", 4901)])
        out = self.out.getvalue()
        self.assertIn("S00001  S00002  S00003", out)
        self.assertIn("thawed: 2", out)
        self.assertIn("not frozen (skipped): 1\n    S00002\n", out)
        self.assertIn("not permitted (frozen by a higher-access GM): 0\n", out)
        self.assertIn("failed: 0", out)
        self.assertEqual(self.results(), {1: "thawed", 2: "not-frozen", 3: "thawed"})
        recs = self.audit_records()
        self.assertEqual(recs[-1]["event"], "session-end")
        self.assertEqual([r["reply"] for r in recs if r["event"] == "thaw"][0], ["Thawing script 1."])
        self.assertTrue(all(r["ts"] and r["target"] == "GS4D" for r in recs))

    def test_usage_stops(self):
        game = FakeThawGame({2: "usage"})
        code = self.run_main(["1", "2", "3"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertEqual(self.thaws(), ["/freeze thaw script 1", "/freeze thaw script 2"])
        self.assertIn("Usage text", self.err.getvalue())
        self.assertIn("S< Usage:", self.err.getvalue())
        self.assertEqual(self.results(), {1: "thawed", 2: "failed", 3: "not-attempted"})
        self.assertIn("failed: 1\n    S00002\n", self.out.getvalue())
        self.assertIn("not attempted: 1\n    S00003\n", self.out.getvalue())

    def test_not_permitted_is_recorded_and_the_run_continues(self):
        game = FakeThawGame({2: "notpermitted", 4: "notpermitted"})
        code = self.run_main(["1", "2", "3", "4"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)  # carried on, but two weren't thawed
        self.assertEqual(len(self.thaws()), 4)
        self.assertEqual(self.results(), {1: "thawed", 2: "not-permitted", 3: "thawed", 4: "not-permitted"})
        out = self.out.getvalue()
        self.assertIn("S00002  NOT PERMITTED: frozen by a higher-access GM", out)
        self.assertIn("not permitted (frozen by a higher-access GM): 2\n    S00002 S00004\n", out)
        self.assertNotIn("STOPPED", self.err.getvalue())
        rec = [r for r in self.audit_records() if r["event"] == "thaw" and r["script"] == 2][0]
        self.assertIn("You can only THAW a resource that you FROZE, or which was FROZEN by a lower accessed GM.",
                      rec["reply"])

    def test_noise_lines_are_ignored(self):
        game = FakeThawGame({1: "noisy", 2: "notpermitted", 3: "noisy"}, chunk=7)
        code = self.run_main(["1", "2", "3"], game=game)
        self.assertEqual(self.results(), {1: "thawed", 2: "not-permitted", 3: "thawed"})
        self.assertEqual(code, thaw.EXIT_FAILED)

    def test_noise_without_a_verdict_still_stops(self):
        game = FakeThawGame({1: "noiseonly"})
        with mock.patch.object(thaw, "REPLY_TIMEOUT", 0.3):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("reply not recognised", self.err.getvalue())
        self.assertIn("SimuCon goodie bag", self.err.getvalue())
        self.assertEqual(self.results(), {1: "failed", 2: "not-attempted"})

    def test_not_permitted_conflicting_with_another_verdict_stops(self):
        self.assertEqual(thaw.classify([NOT_PERMITTED, "Thawing script 5."], 5), "unknown")
        self.assertEqual(thaw.classify([NOT_PERMITTED, "", NOISE, ""], 5), "not-permitted")
        self.assertEqual(thaw.classify([NOISE, "Thawing script 5.", NOISE], 5), "thawed")
        self.assertEqual(thaw.classify([NOISE, ""], 5), "unknown")
        self.assertEqual(thaw.classify([NOT_PERMITTED, "Thawing script 7."], 5), "unknown")
        self.assertEqual(thaw.classify(["Thawing script 5.", "Thawing script 7."], 5), "unknown")
        self.assertEqual(thaw.classify(["Script 4 was not found with a FROZEN or LOCKED status."], 5), "unknown")

    def test_not_permitted_without_its_prompt_stops(self):
        game = FakeThawGame({1: "notpermitted_noprompt"})
        with mock.patch.object(thaw, "REPLY_TIMEOUT", 0.3):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("STOPPED", self.err.getvalue())
        self.assertEqual(self.results(), {1: "failed", 2: "not-attempted"})

    def test_summary_lists_wrap_on_their_own_lines(self):
        ids = [str(n) for n in range(8000, 8020)]
        game = FakeThawGame({n: "notfrozen" for n in range(8000, 8020)})
        code = self.run_main(ids, game=game)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        out = self.out.getvalue()
        summary = out[out.index("Summary:"):]
        lines = [ln for ln in summary.splitlines() if ln.startswith("    S")]
        self.assertEqual([len(ln.split()) for ln in lines], [8, 8, 4])
        self.assertTrue(all(len(ln) < 80 for ln in lines))
        self.assertEqual(" ".join(lines).split(), [f"S{n:05d}" for n in range(8000, 8020)])
        self.assertNotRegex(out, r"S\d{5}S\d")

    def test_unrecognised_reply_stops_with_raw_reply(self):
        for kind in ("weird", "wrongnum"):
            with self.subTest(kind=kind), mock.patch.object(thaw, "REPLY_TIMEOUT", 0.3):
                game = FakeThawGame({1: kind})
                code = self.run_main(["1", "2"], game=game)
                self.assertEqual(code, thaw.EXIT_FAILED)
                self.assertEqual(self.thaws(), ["/freeze thaw script 1"])
                self.assertIn("reply not recognised", self.err.getvalue())
                self.assertIn("S< ", self.err.getvalue())
                self.assertEqual(self.results(), {1: "failed", 2: "not-attempted"})

    def test_timeout_stops_outcome_unknown(self):
        game = FakeThawGame({1: "none"})
        with mock.patch.object(thaw, "REPLY_TIMEOUT", 0.3):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("outcome unknown", self.err.getvalue())
        self.assertEqual(self.results(), {1: "failed", 2: "not-attempted"})

    def test_connection_closed_is_an_error(self):
        game = FakeThawGame({1: "close"})
        code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("closed the connection", self.err.getvalue())
        self.assertEqual(self.results(), {1: "error", 2: "not-attempted"})

    def test_ctrl_c_during_thaw_is_audited(self):
        game = FakeThawGame()
        with mock.patch.object(thaw.ThawSession, "thaw", side_effect=KeyboardInterrupt):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("interrupted (Ctrl+C)", self.err.getvalue())
        self.assertEqual(self.results(), {1: "interrupted", 2: "not-attempted"})
        self.assertEqual(self.audit_records()[-1]["event"], "session-end")
        self.assertEqual(game.lines[-1], "quit")

    def test_ctrl_c_mid_reply_is_audited(self):
        game = FakeThawGame({1: "partial"})
        real_read = thaw.ThawSession._read

        def read_then_interrupt(session, deadline, step):
            text = real_read(session, deadline, step)
            if "Thawing scr" in text:
                raise KeyboardInterrupt
            return text
        with mock.patch.object(thaw.ThawSession, "_read", read_then_interrupt):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("interrupted (Ctrl+C)", self.err.getvalue())
        self.assertEqual(self.results(), {1: "interrupted", 2: "not-attempted"})
        self.assertIn("outcome unknown", [r for r in self.audit_records() if r["event"] == "thaw"][0]["error"])
        self.assertEqual(self.audit_records()[-1]["event"], "session-end")

    def test_stray_prompt_before_reply_is_skipped(self):
        game = FakeThawGame({1: "stray", 2: "stray"})
        code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(self.results(), {1: "thawed", 2: "thawed"})

    def test_fragmented_delivery(self):
        game = FakeThawGame({2: "notfrozen"}, chunk=1)
        code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(self.results(), {1: "thawed", 2: "not-frozen"})

    def test_credentials_scrubbed_everywhere(self):
        game = FakeThawGame({1: "leak", 2: "weird"})
        with mock.patch.object(thaw, "REPLY_TIMEOUT", 0.3):
            code = self.run_main(["1", "2"], game=game)
        self.assertEqual(code, thaw.EXIT_FAILED)
        everything = self.all_output()
        self.assertIn("Weird: <redacted>", everything)
        for secret in (PASSWORD, GAME_KEY, SESSION_KEY, EA_KEY.decode(), ACCOUNT):
            self.assertNotIn(secret, everything)
        self.assertNotIn(json.dumps(PASSWORD)[1:-1], everything)

    def test_bad_password_fails_without_leaking(self):
        code = self.run_main(["5"], game=FakeThawGame(), env={"GSL_PASSWORD": "wrong-password-123"})
        self.assertEqual(code, thaw.EXIT_FAILED)
        self.assertIn("quick login failed due to PASSWORD", self.err.getvalue())
        self.assertNotIn("wrong-password-123", self.all_output())
        self.assertEqual(self.opened, [])

    def test_id_file_and_args_merge(self):
        path = os.path.join(self.dir, "ids.txt")
        with open(path, "w") as f:
            f.write("S2\n3 1\n")
        game = FakeThawGame()
        code = self.run_main(["1", "--file", path], game=game, n=3)
        self.assertEqual(code, thaw.EXIT_OK, self.err.getvalue())
        self.assertEqual(self.thaws(), ["/freeze thaw script 1", "/freeze thaw script 2", "/freeze thaw script 3"])


if __name__ == "__main__":
    unittest.main()
