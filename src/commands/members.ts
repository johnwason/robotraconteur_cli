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

import { RobotRaconteurError } from "robotraconteur";
import type { GeneratorHandle, MemberDefinition, ServiceStub, TimeSpec, TypeDefinition } from "robotraconteur";
import { integerOption, listOption, numberOption, stringOption } from "../args.js";
import { untilStopped } from "../cli.js";
import type { Command, CommandContext } from "../cli.js";
import { codecOf, memberOf, membersOf, scopeOf } from "../connect.js";
import { UsageError } from "../errors.js";
import { formatTime } from "../format.js";
import { functionArguments, valueFromCli, valueToJson } from "../values.js";

const COUNT = { type: "string" as const, short: "n", value: "N", description: "Stop after N values" };

function withoutContainer(t: TypeDefinition): TypeDefinition
{
    const { container: _, ...item } = t;
    return item;
}

/** Print values as they arrive until Ctrl-C, or until count have been printed */
class Stream
{
    private printed = 0;
    readonly stop: ReturnType<typeof untilStopped>;

    constructor(private ctx: CommandContext, private count: number)
    {
        this.stop = untilStopped(ctx.signal);
    }

    /** Print one value: JSON in JSON mode, otherwise text followed by a --- separator */
    print(json: unknown, text: () => string): void
    {
        if (this.count > 0 && this.printed >= this.count) return;
        this.printed++;
        if (this.ctx.out.json) this.ctx.out.value(json);
        else process.stdout.write(text() + "\n---\n");
        if (this.count > 0 && this.printed >= this.count) this.stop.done();
    }
}

// ---------------------------------------------------------------- properties

const propertyGet: Command = {
    name: ["property", "get"],
    usage: "<target> <property>",
    summary: "Read a property",
    connects: true,
    minArgs: 2,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["property"]);
        ctx.out.value(valueToJson(stub, await stub.getProperty(m.name), m.type));
    }
};

const propertySet: Command = {
    name: ["property", "set"],
    usage: "<target> <property> <value>",
    summary: "Write a property",
    connects: true,
    minArgs: 3,
    maxArgs: 3,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["property"]);
        await stub.setProperty(m.name, valueFromCli(stub, ctx.args[2]!, m.type!, m.name));
    }
};

// ---------------------------------------------------------------- functions

function isGenerator(m: MemberDefinition): boolean
{
    return m.type?.container === "generator" || (m.parameters ?? []).some((p) => p.type.container === "generator");
}

/** Step a generator to its end, printing each value, and abort it on Ctrl-C or a failure */
async function runGenerator(ctx: CommandContext, stub: ServiceStub, handle: GeneratorHandle, inputs: unknown[] | undefined, max: number): Promise<void>
{
    const returns = handle.returnType && handle.returnType.type !== "void" ? handle.returnType : undefined;
    let aborted = false;
    const abort = () =>
    {
        aborted = true;
        void stub.callFunctionGenAbort(handle).catch(() => undefined);
    };
    ctx.signal.addEventListener("abort", abort, { once: true });
    try
    {
        for (let i = 0; ; i++)
        {
            if (aborted) throw ctx.signal.reason;
            if ((inputs && i >= inputs.length) || (max > 0 && i >= max))
            {
                await stub.callFunctionGenClose(handle);
                return;
            }
            let value: unknown;
            try
            {
                value = await stub.callFunctionGenNext(handle, inputs?.[i]);
            }
            catch (e)
            {
                if (e instanceof RobotRaconteurError && e.isStopIteration) return;
                if (aborted) throw ctx.signal.reason;
                throw e;
            }
            if (returns) ctx.out.value(valueToJson(stub, value, returns));
        }
    }
    finally
    {
        ctx.signal.removeEventListener("abort", abort);
        if (aborted) await stub.callFunctionGenAbort(handle).catch(() => undefined);
    }
}

const functionCall: Command = {
    name: ["function", "call"],
    usage: "<target> <function> [value...]",
    summary: "Call a function and print its result",
    details: `Give one value for each parameter, or all of them with --args. A generator function is run
to its end, printing each value it gives. A generator that takes a value at each step is given
the --input values in turn, and closed after the last. Ctrl-C aborts a generator.`,
    options: {
        args: { type: "string", short: "a", value: "JSON", description: "The arguments, as a JSON array or an object keyed by parameter name" },
        input: { type: "string", short: "i", multiple: true, value: "VALUE", description: "A value for a generator that takes one at each step" },
        count: { type: "string", short: "n", value: "N", description: "Close a generator after N values" }
    },
    connects: true,
    handlesInterrupt: true,
    minArgs: 2,
    maxArgs: Infinity,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["function"]);
        const args = functionArguments(stub, m, ctx.args.slice(2), stringOption(ctx.values, "args"));
        const generator = isGenerator(m);
        const input_param = m.parameters?.find((p) => p.type.container === "generator");
        const input_texts = listOption(ctx.values, "input");
        if (input_texts.length > 0 && !input_param) throw new UsageError(`${m.name} does not take a value at each step, so takes no --input`);
        if (input_param && input_texts.length === 0) throw new UsageError(`${m.name} takes a value for ${input_param.name} at each step. Give them with --input`);
        const inputs = input_param ? input_texts.map((t, i) => valueFromCli(stub, t, withoutContainer(input_param.type), `--input ${i + 1}`)) : undefined;
        const count = integerOption(ctx.values, "count", 0, 1);
        if (!generator && ctx.values.count !== undefined) throw new UsageError(`${m.name} is not a generator, so takes no --count`);

        const call = stub.callFunction(m.name, args);
        const stop = untilStopped(ctx.signal);
        // A plain call can't be cancelled once sent, so Ctrl-C only stops waiting. A generator that
        // starts after Ctrl-C is aborted, so it does not run unattended
        const result = await Promise.race([call, stop.promise.then(() => undefined)]);
        if (ctx.signal.aborted)
        {
            if (generator) await call.then((h) => stub.callFunctionGenAbort(h as GeneratorHandle)).catch(() => undefined);
            throw ctx.signal.reason;
        }
        if (generator) await runGenerator(ctx, stub, result as GeneratorHandle, inputs, count);
        else if (m.type && m.type.type !== "void") ctx.out.value(valueToJson(stub, result, m.type));
    }
};

// ---------------------------------------------------------------- wires

function wireJson(stub: ServiceStub, m: MemberDefinition, value: unknown, timestamp: TimeSpec): Record<string, unknown>
{
    return { timestamp: formatTime(timestamp), value: valueToJson(stub, value, m.type) };
}

const wirePeek: Command = {
    name: ["wire", "peek"],
    usage: "<target> <wire>",
    summary: "Read the current value of a wire once",
    details: "Reads the value the service sends (the in value), or with --out the value last written to it.",
    options: { out: { type: "boolean", description: "Read the out value, written by clients, instead" } },
    connects: true,
    minArgs: 2,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["wire"]);
        const { value, timestamp } = ctx.values.out ? await stub.peekWireOutValue(m.name) : await stub.peekWireInValue(m.name);
        const j = wireJson(stub, m, value, timestamp);
        if (ctx.out.json) ctx.out.value(j);
        else ctx.out.value(j.value);
    }
};

const wirePoke: Command = {
    name: ["wire", "poke"],
    usage: "<target> <wire> <value>",
    summary: "Write the out value of a wire once",
    connects: true,
    minArgs: 3,
    maxArgs: 3,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["wire"]);
        await stub.pokeWireOutValue(m.name, valueFromCli(stub, ctx.args[2]!, m.type!, m.name));
    }
};

const wireEcho: Command = {
    name: ["wire", "echo"],
    usage: "<target> <wire>",
    summary: "Connect to a wire and print each value it sends",
    details: `Runs until Ctrl-C, or until --count values have been printed. With --json, each line has the
timestamp and value. --rate limits how often values are printed: when they arrive faster, the
newest one is printed at the end of each period and the others are skipped.`,
    options: {
        count: COUNT,
        rate: { type: "string", short: "r", value: "HZ", description: "Print at most HZ values per second" },
        timestamp: { type: "boolean", description: "Print the timestamp of each value in text output" }
    },
    connects: true,
    handlesInterrupt: true,
    minArgs: 2,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["wire"]);
        if (m.modifiers?.includes("writeonly")) throw new Error(`${m.name} is writeonly, so sends no values`);
        const stream = new Stream(ctx, integerOption(ctx.values, "count", 0, 1));
        const rate = numberOption(ctx.values, "rate", 0, 0);
        if (ctx.values.rate !== undefined && rate <= 0) throw new UsageError("--rate must be more than 0");
        const period = rate > 0 ? 1000 / rate : 0;
        const show_time = ctx.values.timestamp === true;
        const print = (j: Record<string, unknown>) =>
        {
            last_print = performance.now();
            stream.print(j, () => show_time ? `# ${String(j.timestamp)}\n${ctx.out.format(j.value)}` : ctx.out.format(j.value));
        };
        let last_print = -Infinity;
        // The newest value waiting for the period to end, which replaces any older one
        let pending: Record<string, unknown> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const handle = await stub.connectWire(m.name);
        stub.setWireCloseCallback(handle, () => stream.stop.fail(new Error(`The service closed wire ${m.name}`)));
        stub.addWireValueChangedListener(handle, (_h, value, timestamp) =>
        {
            const j = wireJson(stub, m, value, timestamp);
            const wait = last_print + period - performance.now();
            if (wait <= 0 && timer === undefined)
            {
                print(j);
                return;
            }
            pending = j;
            timer ??= setTimeout(() =>
            {
                timer = undefined;
                const p = pending!;
                pending = undefined;
                print(p);
            }, wait);
        });
        try
        {
            await stream.stop.promise;
        }
        finally
        {
            clearTimeout(timer);
            stub.setWireCloseCallback(handle, null);
            await stub.closeWire(handle).catch(() => undefined);
        }
    }
};

const wireHz: Command = {
    name: ["wire", "hz"],
    usage: "<target> <wire>",
    summary: "Measure how often a wire sends values",
    details: "Prints the rate every --every seconds, over the last --window values, until Ctrl-C.",
    options: {
        window: { type: "string", value: "N", description: "Number of values to average over (default 100)" },
        every: { type: "string", value: "SECONDS", description: "How often to print the rate (default 1)" },
        count: { type: "string", short: "n", value: "N", description: "Stop after printing the rate N times" }
    },
    connects: true,
    handlesInterrupt: true,
    minArgs: 2,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["wire"]);
        const window = integerOption(ctx.values, "window", 100, 2);
        const every = numberOption(ctx.values, "every", 1, 0.1);
        const count = integerOption(ctx.values, "count", 0, 1);
        const stop = untilStopped(ctx.signal);
        const times: number[] = [];
        let arrived = 0;
        const handle = await stub.connectWire(m.name);
        stub.setWireCloseCallback(handle, () => stop.fail(new Error(`The service closed wire ${m.name}`)));
        stub.addWireValueChangedListener(handle, () =>
        {
            arrived++;
            times.push(performance.now());
            if (times.length > window + 1) times.shift();
        });
        let printed = 0;
        const timer = setInterval(() =>
        {
            const fresh = arrived > 0;
            arrived = 0;
            if (!fresh || times.length < 2) ctx.out.either({ rate: null }, "no new values");
            else
            {
                const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000);
                const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
                const std = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
                const stats = { rate: 1 / mean, min: Math.min(...gaps), max: Math.max(...gaps), std_dev: std, window: gaps.length };
                ctx.out.either(stats, `average rate: ${stats.rate.toFixed(3)}\n\tmin: ${stats.min.toFixed(3)}s max: ${stats.max.toFixed(3)}s std dev: ${stats.std_dev.toFixed(5)}s window: ${stats.window}`);
            }
            if (count > 0 && ++printed >= count) stop.done();
        }, every * 1000);
        try
        {
            await stop.promise;
        }
        finally
        {
            clearInterval(timer);
            stub.setWireCloseCallback(handle, null);
            await stub.closeWire(handle).catch(() => undefined);
        }
    }
};

// ---------------------------------------------------------------- pipes

const pipeEcho: Command = {
    name: ["pipe", "echo"],
    usage: "<target> <pipe>",
    summary: "Connect to a pipe and print each packet it sends",
    details: "Runs until Ctrl-C, or until --count packets have been printed.",
    options: {
        count: COUNT,
        index: { type: "string", value: "N", description: "The pipe endpoint index to request (default any)" }
    },
    connects: true,
    handlesInterrupt: true,
    minArgs: 2,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const m = memberOf(stub, ctx.args[1]!, ["pipe"]);
        if (m.modifiers?.includes("writeonly")) throw new Error(`${m.name} is writeonly, so sends no packets`);
        const stream = new Stream(ctx, integerOption(ctx.values, "count", 0, 1));
        const handle = await stub.connectPipe(m.name, integerOption(ctx.values, "index", -1, -1));
        stub.setPipeCloseCallback(handle, () => stream.stop.fail(new Error(`The service closed pipe ${m.name}`)));
        stub.addPipePacketReceivedListener(handle, (h) =>
        {
            while (stub.getPipePacketsAvailable(h) > 0)
            {
                const j = valueToJson(stub, stub.receivePipePacket(h), m.type);
                stream.print(j, () => ctx.out.format(j));
            }
        });
        try
        {
            await stream.stop.promise;
        }
        finally
        {
            stub.setPipeCloseCallback(handle, null);
            await stub.closePipe(handle).catch(() => undefined);
        }
    }
};

// ---------------------------------------------------------------- events

const eventEcho: Command = {
    name: ["event", "echo"],
    usage: "<target> [event]",
    summary: "Print events as the service sends them, all of them or one",
    details: "Runs until Ctrl-C, or until --count events have been printed.",
    options: { count: COUNT },
    connects: true,
    handlesInterrupt: true,
    minArgs: 1,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const events = ctx.args[1] !== undefined ? [memberOf(stub, ctx.args[1], ["event"])] : membersOf(stub).filter((m) => m.kind === "event");
        if (events.length === 0) throw new Error(`${stub.objectType} has no events`);
        const stream = new Stream(ctx, integerOption(ctx.values, "count", 0, 1));
        const codec = codecOf(stub);
        const scope = scopeOf(stub);
        const handlers = events.map((m) =>
        {
            const handler = (...values: unknown[]) =>
            {
                const args = Object.fromEntries((m.parameters ?? []).map((p, i) => [p.name, codec.toJson(values[i], p.type, scope)]));
                const time = new Date().toISOString();
                stream.print({ time, event: m.name, arguments: args }, () => Object.keys(args).length > 0 ? `# ${m.name} ${time}\n${ctx.out.format(args)}` : `# ${m.name} ${time}`);
            };
            stub.addEventListener(m.name, handler);
            return () => stub.removeEventListener(m.name, handler);
        });
        try
        {
            await stream.stop.promise;
        }
        finally
        {
            for (const remove of handlers) remove();
        }
    }
};

export const memberCommands = [propertyGet, propertySet, functionCall, wirePeek, wireEcho, wireHz, wirePoke, pipeEcho, eventEcho];

