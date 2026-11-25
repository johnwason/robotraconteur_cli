// Copyright 2011-2026 Wason Technology, LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Runs rrac against test/services/cli_test_service.py. Run from the package folder, inside the
// development image, which has Python Robot Raconteur.

import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";

const PORT = 52731;
const URL = `rr+tcp://localhost:${PORT}?service=test`;
const NODE_NAME = "rrac_cli_test";

interface Result
{
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Run rrac, optionally sending SIGINT after a while, and collect its output */
function rrac(args: string[], options: { interruptAfter?: number; timeout?: number } = {}): Promise<Result>
{
    return new Promise((resolve, reject) =>
    {
        const p = spawn(process.execPath, ["dist/index.js", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        const kill = setTimeout(() => p.kill("SIGKILL"), options.timeout ?? 30000);
        const interrupt = options.interruptAfter === undefined ? undefined : setTimeout(() => p.kill("SIGINT"), options.interruptAfter);
        p.on("error", reject);
        p.on("close", (code) =>
        {
            clearTimeout(kill);
            clearTimeout(interrupt);
            resolve({ code, stdout, stderr });
        });
    });
}

async function ok(args: string[]): Promise<string>
{
    const r = await rrac(args);
    assert.equal(r.code, 0, `rrac ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
}

async function json(args: string[]): Promise<unknown>
{
    return JSON.parse(await ok([...args, "--json"]));
}

async function jsonLines(args: string[]): Promise<unknown[]>
{
    return (await ok([...args, "--json"])).trim().split("\n").map((l) => JSON.parse(l));
}

async function fails(args: string[], code: number, message: RegExp): Promise<void>
{
    const r = await rrac(args);
    assert.equal(r.code, code, `rrac ${args.join(" ")} should fail with ${code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
}

let service: ChildProcess;

before(async () =>
{
    service = spawn("python3", ["test/services/cli_test_service.py", "--port", String(PORT), "--name", NODE_NAME], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
    });
    await new Promise<void>((resolve, reject) =>
    {
        let out = "";
        service.stdout!.on("data", (d: Buffer) =>
        {
            out += d.toString();
            if (out.includes("PORT")) resolve();
        });
        service.on("exit", (code) => reject(new Error(`The test service exited with ${code}`)));
    });
});

after(() =>
{
    service.stdin!.end();
    service.kill();
});

describe("describe and robdef", () =>
{
    test("describe an object", async () =>
    {
        const text = await ok(["describe", URL]);
        assert.match(text, /^object experimental\.rrac_test\.TestObject$/m);
        assert.match(text, /^ {4}function double add\(double a, double b\)$/m);
        assert.match(text, /^ {4}wire double\[\] position \[readonly\]$/m);
        const j = await json(["describe", URL]) as { objectType: string; members: { name: string }[] };
        assert.equal(j.objectType, "experimental.rrac_test.TestObject");
        assert.ok(j.members.some((m) => m.name === "numbers"));
    });

    test("describe a member and its types", async () =>
    {
        const text = await ok(["describe", URL, "point"]);
        assert.match(text, /^struct experimental\.rrac_test\.Point\n {4}field double x\n {4}field double y\nend$/m);
        const j = await json(["describe", URL, "mode"]) as { types: Record<string, { values: Record<string, number> }> };
        assert.deepEqual(j.types["experimental.rrac_test.Mode"]!.values, { idle: 0, run: 1 });
        await fails(["describe", URL, "nope"], 1, /has no member "nope"/);
    });

    test("describe a sub object", async () =>
    {
        assert.match(await ok(["describe", URL, "-o", "arms[0]"]), /^object experimental\.rrac_test\.Arm$/m);
    });

    test("robdef list and show", async () =>
    {
        assert.deepEqual(await json(["robdef", "list", URL]), ["experimental.rrac_test"]);
        const text = await ok(["robdef", "show", URL]);
        assert.match(text, /^service experimental\.rrac_test$/m);
        assert.match(text, /^ {4}event message\(string text, int32 n\)$/m);
        const parsed = await json(["robdef", "show", URL, "experimental.rrac_test"]) as { name: string };
        assert.equal(parsed.name, "experimental.rrac_test");
        await fails(["robdef", "show", URL, "other"], 1, /does not use a definition named "other"/);
    });

    test("robdef check and parse, without a service", async () =>
    {
        const f = (n: string) => `test/fixtures/${n}.robdef`;
        assert.match(await ok(["robdef", "check", f("example.base"), f("example.robot")]), /example\.robot OK/);
        await fails(["robdef", "check", f("example.robot")], 1, /example\.base/);
        await fails(["robdef", "check", f("example.undefined")], 1, /Missing/);
        await fails(["robdef", "check", f("example.syntax")], 1, /example\.syntax\.robdef/);
        await fails(["robdef", "check", "test/fixtures/none.robdef"], 2, /Could not read/);
        const parsed = await json(["robdef", "parse", f("example.robot")]) as { imports: string[] };
        assert.deepEqual(parsed.imports, ["example.base"]);
    });
});

describe("properties", () =>
{
    test("get and set", async () =>
    {
        assert.deepEqual(await json(["property", "get", URL, "point"]), { x: 1.5, y: -2 });
        assert.equal(await ok(["property", "get", URL, "point"]), "x: 1.5\ny: -2\n");
        await ok(["property", "set", URL, "counter", "-7"]);
        assert.equal(await json(["property", "get", URL, "counter"]), -7);
        await ok(["property", "set", URL, "values", "[4, 5.5]"]);
        assert.equal(await ok(["property", "get", URL, "values"]), "[4, 5.5]\n");
        await ok(["property", "set", URL, "point", "{\"x\": 3}"]);
        assert.deepEqual(await json(["property", "get", URL, "point"]), { x: 3, y: 0 });
    });

    test("64-bit integers and enums", async () =>
    {
        assert.equal(await json(["property", "get", URL, "big"]), "9007199254740993");
        await ok(["property", "set", URL, "big", "\"-9007199254740995\""]);
        assert.equal(await json(["property", "get", URL, "big"]), "-9007199254740995");
        await ok(["property", "set", URL, "mode", "idle"]);
        assert.deepEqual(await json(["property", "get", URL, "mode"]), { value: 0, name: "idle" });
        await ok(["property", "set", URL, "mode", "1"]);
        assert.deepEqual(await json(["property", "get", URL, "mode"]), { value: 1, name: "run" });
    });

    test("sub objects", async () =>
    {
        assert.equal(await ok(["property", "get", URL, "name", "--object", "arm"]), "main\n");
        assert.equal(await ok(["property", "get", URL, "name", "-o", "arms[1]"]), "right\n");
    });

    test("errors", async () =>
    {
        await fails(["property", "get", URL, "nothing"], 1, /has no property named "nothing"/);
        await fails(["property", "get", URL, "add"], 1, /"add" is a function, not a property\. Use rrac function call/);
        await fails(["property", "set", URL, "point", "{\"z\": 1}"], 2, /has no field "z"/);
        await fails(["property", "set", URL, "counter", "abc"], 2, /expected a int32/);
        await fails(["property", "get", URL], 2, /Missing arguments/);
    });
});

describe("functions", () =>
{
    test("plain calls", async () =>
    {
        assert.equal(await json(["function", "call", URL, "add", "1", "-2.5"]), -1.5);
        assert.equal(await json(["function", "call", URL, "add", "--args", "[1, 2]"]), 3);
        assert.equal(await json(["function", "call", URL, "add", "--args", "{\"b\": 5, \"a\": 1}"]), 6);
        assert.equal(await ok(["function", "call", URL, "echo", "hello world"]), "hello world\n");
        assert.equal(await ok(["function", "call", URL, "fire", "x", "1"]), "");
    });

    test("generators", async () =>
    {
        assert.deepEqual(await jsonLines(["function", "call", URL, "count_to", "4"]), [1, 2, 3, 4]);
        assert.deepEqual(await jsonLines(["function", "call", URL, "count_to", "10", "-n", "2"]), [1, 2]);
        assert.deepEqual(await jsonLines(["function", "call", URL, "accumulate", "-i", "1", "-i", "2.5", "-i", "-1"]), [1, 3.5, 2.5]);
        await fails(["function", "call", URL, "accumulate"], 2, /Give them with --input/);
        await fails(["function", "call", URL, "add", "1", "2", "-i", "3"], 2, /takes no --input/);
    });

    test("errors", async () =>
    {
        await fails(["function", "call", URL, "fail"], 1, /RobotRaconteur\.InvalidOperation: fail was called/);
        await fails(["function", "call", URL, "add", "1"], 2, /add\(a, b\) takes 2 arguments but 1 was given/);
        await fails(["function", "call", URL, "add", "1", "2", "--args", "[1, 2]"], 2, /not both/);
        await fails(["function", "call", URL, "add", "--args", "{\"c\": 1}"], 2, /no parameter "c"/);
    });
});

describe("wires and pipes", () =>
{
    test("peek", async () =>
    {
        const r = await json(["wire", "peek", URL, "position"]) as { timestamp: string; value: number[] };
        assert.match(r.timestamp, /^\d+\.\d{9}$/);
        assert.equal(r.value.length, 2);
        assert.equal(r.value[1], 0.5);
    });

    test("echo a number of values", async () =>
    {
        const values = await jsonLines(["wire", "echo", URL, "position", "-n", "5"]) as { value: number[] }[];
        assert.equal(values.length, 5);
        for (let i = 1; i < values.length; i++) assert.ok(values[i]!.value[0]! > values[i - 1]!.value[0]!);
        const text = await ok(["wire", "echo", URL, "position", "-n", "2"]);
        assert.match(text, /^\[\d+, 0\.5\]\n---\n\[\d+, 0\.5\]\n---\n$/);
    });

    test("echo at a limited rate", async () =>
    {
        // The service sends 50 values a second, so at 5 a second about 10 are skipped between each
        const values = await jsonLines(["wire", "echo", URL, "position", "-n", "3", "--rate", "5"]) as { timestamp: string; value: number[] }[];
        assert.equal(values.length, 3);
        for (let i = 1; i < values.length; i++)
        {
            const gap = Number(values[i]!.timestamp) - Number(values[i - 1]!.timestamp);
            assert.ok(gap >= 0.15 && gap < 0.4, `gap ${gap}`);
            assert.ok(values[i]!.value[0]! - values[i - 1]!.value[0]! >= 5, JSON.stringify(values));
        }
        await fails(["wire", "echo", URL, "position", "--rate", "0"], 2, /--rate must be more than 0/);
    });

    test("echo stops cleanly on Ctrl-C", async () =>
    {
        const r = await rrac(["wire", "echo", URL, "position", "--json"], { interruptAfter: 1500 });
        assert.equal(r.code, 0, r.stderr);
        assert.ok(r.stdout.trim().split("\n").length >= 5);
    });

    test("hz", async () =>
    {
        const [stats] = await jsonLines(["wire", "hz", URL, "position", "-n", "1"]) as { rate: number }[];
        assert.ok(stats!.rate > 30 && stats!.rate < 70, `rate ${stats!.rate}`);
    });

    test("poke", async () =>
    {
        await ok(["wire", "poke", URL, "command", "{\"x\": 1, \"y\": -1}"]);
        assert.deepEqual(await json(["function", "call", URL, "last_command"]), { x: 1, y: -1 });
        await fails(["wire", "poke", URL, "command", "[1]"], 2, /expected an object/);
    });

    test("pipe echo", async () =>
    {
        const values = await jsonLines(["pipe", "echo", URL, "numbers", "-n", "3"]) as number[];
        assert.equal(values.length, 3);
        assert.equal(values[1], values[0]! + 1);
        assert.equal(values[2], values[1]! + 1);
    });

    test("wrong kinds", async () =>
    {
        await fails(["wire", "peek", URL, "counter"], 1, /is a property, not a wire/);
        await fails(["wire", "echo", URL, "command"], 1, /writeonly/);
        await fails(["pipe", "echo", URL, "position"], 1, /is a wire, not a pipe/);
    });
});

describe("events", () =>
{
    test("echo events", async () =>
    {
        const echo = rrac(["event", "echo", URL, "message", "-n", "2", "--json"]);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await ok(["function", "call", URL, "fire", "first", "1"]);
        await ok(["function", "call", URL, "fire", "second", "2"]);
        const r = await echo;
        assert.equal(r.code, 0, r.stderr);
        const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { event: string; arguments: unknown });
        assert.deepEqual(events.map((e) => [e.event, e.arguments]), [["message", { text: "first", n: 1 }], ["message", { text: "second", n: 2 }]]);
    });

    test("an object without events", async () =>
    {
        await fails(["event", "echo", URL, "-o", "arm"], 1, /has no events/);
    });
});

describe("discovery", () =>
{
    test("discover", async () =>
    {
        const list = await json(["discover"]) as { name: string; type: string; nodeName: string }[];
        const found = list.find((s) => s.name === `${NODE_NAME}/test`);
        assert.ok(found, JSON.stringify(list));
        assert.equal(found.type, "experimental.rrac_test.TestObject");
        assert.ok(!list.some((s) => s.name.endsWith("/RobotRaconteurServiceIndex")));
        const all = await json(["discover", "--all", "--node", NODE_NAME]) as { name: string }[];
        assert.ok(all.some((s) => s.name === `${NODE_NAME}/RobotRaconteurServiceIndex`));
        assert.deepEqual(await json(["discover", "--type", "experimental.rrac_test.Arm"]), []);
        assert.match(await ok(["discover"]), new RegExp(`^${NODE_NAME}/test +experimental\\.rrac_test\\.TestObject$`, "m"));
    });

    test("nodes", async () =>
    {
        const nodes = await json(["node", "list"]) as { nodeName: string }[];
        assert.ok(nodes.some((n) => n.nodeName === NODE_NAME));
        const info = await json(["node", "info", NODE_NAME]) as { services: { service: string }[] };
        assert.deepEqual(info.services.map((s) => s.service), ["test"]);
        await fails(["node", "info", "nothing_here", "-w", "1"], 1, /not found/);
    });

    test("connect by name", async () =>
    {
        await ok(["property", "set", URL, "counter", "12"]);
        assert.equal(await json(["property", "get", `${NODE_NAME}/test`, "counter"]), 12);
        assert.equal(await json(["property", "get", "test", "counter"]), 12);
        await fails(["property", "get", "missing/test", "counter", "-t", "2"], 1, /was not found within 2 s/);
    });
});

describe("command line", () =>
{
    test("help and usage errors", async () =>
    {
        assert.match(await ok(["--help"]), /rrac wire echo <target> <wire>/);
        assert.match(await ok(["wire", "--help"]), /rrac wire hz/);
        assert.match(await ok(["wire", "echo", "--help"]), /--count N/);
        assert.match(await ok(["--version"]), /^rrac \d+\.\d+\.\d+/);
        await fails(["wire", "nope"], 2, /unknown command "wire nope"/);
        await fails(["nope"], 2, /unknown command "nope"/);
        await fails(["discover", "--bogus"], 2, /Unknown option --bogus/);
    });
});
