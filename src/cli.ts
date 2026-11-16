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

import type { ServiceStub } from "robotraconteur";
import { integerOption, numberOption, parseArgs, stringOption } from "./args.js";
import type { OptionSpec, OptionValues } from "./args.js";
import { Session } from "./connect.js";
import { errorText, UsageError } from "./errors.js";
import { Output } from "./format.js";

export const VERSION = "0.1.0";

/** What a command is given when it runs */
export interface CommandContext
{
    /** The positional arguments */
    args: string[];
    values: OptionValues;
    out: Output;
    /** The Robot Raconteur node, created on first use */
    session(): Session;
    /** Connect to the target, selecting the object given by --object */
    connect(target: string): Promise<ServiceStub>;
    /** Aborted when the user presses Ctrl-C */
    signal: AbortSignal;
}

export interface Command
{
    /** The words that select it, such as ["wire", "echo"] */
    name: string[];
    /** The positional arguments, as shown in the help, such as "<target> <wire>" */
    usage: string;
    summary: string;
    /** More help, shown by --help on the command */
    details?: string;
    options?: Record<string, OptionSpec>;
    /** Whether it connects to services, so takes the connection options */
    connects?: boolean;
    minArgs: number;
    maxArgs: number;
    /**
     * Whether it stops by itself, cleanly, when the signal aborts, such as a stream that ends on
     * Ctrl-C. Other commands are abandoned at once
     */
    handlesInterrupt?: boolean;
    run(ctx: CommandContext): Promise<void>;
}

const OUTPUT_OPTIONS: Record<string, OptionSpec> = {
    json: { type: "boolean", description: "Print JSON, one value per line, for scripts" },
    "max-array": { type: "string", value: "N", description: "Shorten arrays to N items in text output" },
    help: { type: "boolean", short: "h", description: "Show help" }
};

const CONNECTION_OPTIONS: Record<string, OptionSpec> = {
    object: { type: "string", short: "o", value: "PATH", description: "Use a sub object, such as arm or arm.tool[0]" },
    timeout: { type: "string", short: "t", value: "SECONDS", description: "Time to find and connect to the service (default 10)" },
    "request-timeout": { type: "string", value: "SECONDS", description: "Time to wait for each request (default 120)" },
    username: { type: "string", short: "u", value: "NAME", description: "Username for services that require one" },
    "password-env": { type: "string", value: "VAR", description: "Environment variable holding the password (default RRAC_PASSWORD)" },
    ipv4: { type: "boolean", description: "Also search with IPv4 broadcast, as well as IPv6 multicast" }
};

const TARGET_HELP = `<target> is a service URL, such as rr+tcp://localhost:29200?service=reynard, or a service
found on the network, as node/service, such as Reynard/reynard, or service alone if only one
node has it.`;

const VALUE_HELP = `Values are JSON, such as 1.5, [1,2,3], or {"x":1}. Strings and enum names need no quotes.
@file reads the JSON from a file.`;

function optionHelp(options: Record<string, OptionSpec>): string[]
{
    const rows = Object.entries(options).map(([name, o]) =>
    {
        const flag = `${o.short ? `-${o.short}, ` : "    "}--${name}${o.value ? ` ${o.value}` : ""}`;
        return [flag, o.description + (o.multiple ? " (repeatable)" : "")] as const;
    });
    const width = Math.max(...rows.map((r) => r[0].length));
    return rows.map(([flag, d]) => `  ${flag.padEnd(width)}  ${d}`);
}

function commandHelp(c: Command): string
{
    const out = [`Usage: rrac ${c.name.join(" ")}${c.usage ? " " + c.usage : ""} [options]`, "", c.summary];
    if (c.details) out.push("", c.details);
    if (c.usage.includes("<target>")) out.push("", TARGET_HELP);
    if (c.usage.includes("<value>") || c.usage.includes("[value...]")) out.push("", VALUE_HELP);
    if (c.options && Object.keys(c.options).length > 0) out.push("", "Options:", ...optionHelp(c.options));
    if (c.connects) out.push("", "Connection options:", ...optionHelp(CONNECTION_OPTIONS));
    out.push("", "Output options:", ...optionHelp(OUTPUT_OPTIONS));
    return out.join("\n");
}

function groupHelp(commands: Command[], prefix: string[]): string
{
    const shown = commands.filter((c) => prefix.every((w, i) => c.name[i] === w));
    const rows = shown.map((c) => [`rrac ${c.name.join(" ")}${c.usage ? " " + c.usage : ""}`, c.summary] as const);
    const width = Math.max(...rows.map((r) => r[0].length));
    const out: string[] = [];
    if (prefix.length === 0)
    {
        out.push("rrac: use Robot Raconteur services from the command line", "", "Usage: rrac <command> [arguments] [options]", "");
    }
    out.push("Commands:", ...rows.map(([u, s]) => `  ${u.padEnd(width)}  ${s}`), "", "Run rrac <command> --help for the options of a command.");
    return out.join("\n");
}

/** The command the leading words select, and the arguments after them */
function findCommand(commands: Command[], argv: string[]): { command?: Command; rest: string[]; prefix: string[] }
{
    let best: Command | undefined;
    for (const c of commands)
    {
        if (c.name.every((w, i) => argv[i] === w) && (!best || c.name.length > best.name.length)) best = c;
    }
    if (best) return { command: best, rest: argv.slice(best.name.length), prefix: best.name };
    // The longest group the words select, for its help
    const prefix: string[] = [];
    for (const w of argv)
    {
        if (!commands.some((c) => [...prefix, w].every((x, i) => c.name[i] === x))) break;
        prefix.push(w);
    }
    return { rest: argv.slice(prefix.length), prefix };
}

/** Run the command line, returning the exit code: 0 for success, 1 for a failure, 2 for a usage error */
export async function main(commands: Command[], argv: string[]): Promise<number>
{
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
    {
        process.stdout.write(groupHelp(commands, []) + "\n");
        return argv.length === 0 ? 2 : 0;
    }
    if (argv[0] === "--version")
    {
        process.stdout.write(`rrac ${VERSION}\n`);
        return 0;
    }

    const { command, rest, prefix } = findCommand(commands, argv);
    if (!command)
    {
        const help = rest.length === 0 || rest[0] === "--help" || rest[0] === "-h";
        if (prefix.length > 0 && help)
        {
            process.stdout.write(groupHelp(commands, prefix) + "\n");
            return 0;
        }
        const what = prefix.length > 0 ? `"${[...prefix, rest[0]].join(" ")}"` : `"${argv[0]}"`;
        process.stderr.write(`rrac: unknown command ${what}\n\n${groupHelp(commands, prefix)}\n`);
        return 2;
    }

    const options = { ...OUTPUT_OPTIONS, ...(command.connects ? CONNECTION_OPTIONS : {}), ...command.options };
    let session: Session | undefined;
    const abort = new AbortController();
    let interrupts = 0;
    const on_interrupt = () =>
    {
        // A second Ctrl-C leaves at once, in case the first is stuck waiting for a service
        if (++interrupts > 1) process.exit(130);
        abort.abort(new Error("Interrupted"));
    };
    process.on("SIGINT", on_interrupt);
    try
    {
        const { positionals, values } = parseArgs(rest, options);
        if (values.help)
        {
            process.stdout.write(commandHelp(command) + "\n");
            return 0;
        }
        if (positionals.length < command.minArgs || positionals.length > command.maxArgs)
        {
            throw new UsageError(positionals.length < command.minArgs ? "Missing arguments" : `Unexpected argument "${positionals[command.maxArgs]}"`);
        }
        const out = new Output({ json: values.json === true, maxArray: values["max-array"] === undefined ? undefined : integerOption(values, "max-array", 0, 1) });
        const make_session = () =>
        {
            if (!session)
            {
                const username = stringOption(values, "username");
                const password_env = stringOption(values, "password-env") ?? "RRAC_PASSWORD";
                session = new Session({
                    timeout: numberOption(values, "timeout", 10) * 1000,
                    requestTimeout: numberOption(values, "request-timeout", 120) * 1000,
                    username,
                    password: username === undefined ? undefined : process.env[password_env],
                    ipv4: values.ipv4 === true
                });
            }
            return session;
        };
        const ctx: CommandContext = {
            args: positionals,
            values,
            out,
            session: make_session,
            connect: (target) => untilAborted(make_session().connect(target, stringOption(values, "object")), abort.signal),
            signal: abort.signal
        };
        if (command.handlesInterrupt) await command.run(ctx);
        else await untilAborted(command.run(ctx), abort.signal);
        return 0;
    }
    catch (e)
    {
        if (e instanceof UsageError)
        {
            process.stderr.write(`rrac ${command.name.join(" ")}: ${e.message}\nRun rrac ${command.name.join(" ")} --help for usage.\n`);
            return 2;
        }
        if (abort.signal.aborted) return 130;
        process.stderr.write(`rrac ${command.name.join(" ")}: ${errorText(e)}\n`);
        return 1;
    }
    finally
    {
        process.off("SIGINT", on_interrupt);
        await session?.close();
    }
}

/** Wait for a promise, but stop waiting with an error if the signal aborts first */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const stop = () => reject(signal.reason);
        if (signal.aborted) stop();
        signal.addEventListener("abort", stop, { once: true });
        p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
}

/** Wait until the signal aborts, or done is called, whichever is first */
export function untilStopped(signal: AbortSignal): { promise: Promise<void>; done: () => void; fail: (e: unknown) => void }
{
    let done!: () => void;
    let fail!: (e: unknown) => void;
    const promise = new Promise<void>((resolve, reject) =>
    {
        done = resolve;
        fail = reject;
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { promise, done, fail };
}
