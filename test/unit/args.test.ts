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

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { integerOption, numberOption, parseArgs } from "../../src/args.js";
import type { OptionSpec } from "../../src/args.js";
import { isUrl, parseObjectPath, parseServiceName } from "../../src/connect.js";
import { UsageError } from "../../src/errors.js";
import { formatText, formatTime } from "../../src/format.js";
import { parseCliJson } from "../../src/values.js";

const OPTIONS: Record<string, OptionSpec> = {
    json: { type: "boolean", description: "" },
    count: { type: "string", short: "n", description: "" },
    input: { type: "string", short: "i", multiple: true, description: "" }
};

describe("parseArgs", () =>
{
    test("options anywhere among positionals", () =>
    {
        const r = parseArgs(["a", "--json", "b", "-n", "3", "--count=4", "c"], OPTIONS);
        assert.deepEqual(r.positionals, ["a", "b", "c"]);
        assert.deepEqual(r.values, { json: true, count: "4" });
    });

    test("negative numbers are values", () =>
    {
        const r = parseArgs(["-1", "-0.5", "-.5", "-Infinity", "-n", "-2"], OPTIONS);
        assert.deepEqual(r.positionals, ["-1", "-0.5", "-.5", "-Infinity"]);
        assert.equal(r.values.count, "-2");
    });

    test("repeatable options collect values", () =>
    {
        assert.deepEqual(parseArgs(["-i", "1", "--input", "2"], OPTIONS).values.input, ["1", "2"]);
    });

    test("everything after -- is positional", () =>
    {
        assert.deepEqual(parseArgs(["--", "--json", "-n"], OPTIONS).positionals, ["--json", "-n"]);
    });

    test("errors", () =>
    {
        assert.throws(() => parseArgs(["--nope"], OPTIONS), UsageError);
        assert.throws(() => parseArgs(["-x"], OPTIONS), UsageError);
        assert.throws(() => parseArgs(["--count"], OPTIONS), /needs a value/);
        assert.throws(() => parseArgs(["--json=1"], OPTIONS), /does not take a value/);
    });

    test("number options", () =>
    {
        assert.equal(numberOption({ t: "2.5" }, "t", 10), 2.5);
        assert.equal(numberOption({}, "t", 10), 10);
        assert.throws(() => numberOption({ t: "x" }, "t", 10), UsageError);
        assert.throws(() => integerOption({ n: "1.5" }, "n", 0), UsageError);
        assert.throws(() => integerOption({ n: "0" }, "n", 0, 1), UsageError);
    });
});

describe("targets", () =>
{
    test("URLs and names", () =>
    {
        assert.ok(isUrl("rr+tcp://localhost:1234?service=x"));
        assert.ok(isUrl("rr+wss://host/?service=x"));
        assert.ok(!isUrl("Node/service"));
        assert.deepEqual(parseServiceName("Reynard/reynard"), { node: "Reynard", service: "reynard" });
        assert.deepEqual(parseServiceName("reynard"), { service: "reynard" });
        assert.throws(() => parseServiceName("a/b/c"), UsageError);
        assert.throws(() => parseServiceName("/b"), UsageError);
    });

    test("object paths", () =>
    {
        assert.deepEqual(parseObjectPath("arm.tool[0]"), [{ name: "arm", index: undefined }, { name: "tool", index: 0 }]);
        assert.deepEqual(parseObjectPath("tools[a.b]"), [{ name: "tools", index: "a.b" }]);
        assert.deepEqual(parseObjectPath(""), []);
        assert.throws(() => parseObjectPath("arm..tool"), UsageError);
    });
});

describe("values", () =>
{
    test("strings need no quotes", () =>
    {
        assert.equal(parseCliJson("hello world", { type: "string" }), "hello world");
        assert.equal(parseCliJson("123", { type: "string" }), "123");
        assert.equal(parseCliJson("\"quoted\"", { type: "string" }), "quoted");
    });

    test("other types are JSON, or left as text for enum names", () =>
    {
        assert.deepEqual(parseCliJson("[1,2]", { type: "double", array: "array" }), [1, 2]);
        assert.equal(parseCliJson("-3", { type: "int32" }), -3);
        assert.equal(parseCliJson("halt", { type: "Mode" }), "halt");
    });
});

describe("formatText", () =>
{
    test("scalars and arrays", () =>
    {
        assert.equal(formatText(1.5), "1.5");
        assert.equal(formatText("hi"), "hi");
        assert.equal(formatText(""), "\"\"");
        assert.equal(formatText("12"), "\"12\"");
        assert.equal(formatText(null), "null");
        assert.equal(formatText([1, 2, 3]), "[1, 2, 3]");
        assert.equal(formatText([1, 2, 3], 2), "[1, 2, ... 1 more]");
    });

    test("nested values", () =>
    {
        assert.equal(formatText({ a: 1, b: { c: [1, 2], d: "x: y" }, e: [] }), "a: 1\nb:\n  c: [1, 2]\n  d: \"x: y\"\ne: []");
        assert.equal(formatText([{ a: 1, b: 2 }, { a: 3, b: 4 }]), "- a: 1\n  b: 2\n- a: 3\n  b: 4");
        assert.equal(formatText({ m: [[1, 2], [3]] }), "m:\n  - [1, 2]\n  - [3]");
    });

    test("times", () =>
    {
        assert.equal(formatTime({ seconds: 12n, nanoseconds: 5000 }), "12.000005000");
    });
});
