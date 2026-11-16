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

import { UsageError } from "./errors.js";

/** An option a command accepts */
export interface OptionSpec
{
    /** Whether the option takes a value, such as --count 5, or is a flag, such as --json */
    type: "string" | "boolean";
    /** A one letter alias, such as o for -o */
    short?: string;
    /** Whether it can be given more than once, collecting the values in order */
    multiple?: boolean;
    /** The name of its value in the help, such as N or SECONDS */
    value?: string;
    description: string;
}

export type OptionValues = Record<string, string | boolean | string[] | undefined>;

export interface ParsedArgs
{
    positionals: string[];
    values: OptionValues;
}

/** A negative number is a value, not an option, so that values such as -1.5 need no -- before them */
const NEGATIVE_NUMBER = /^-(\d|\.\d|Infinity$)/;

/**
 * Parse the arguments after the command name. Options may come before, between, or after the
 * positional arguments, as --name value, --name=value, or -n value. Everything after -- is positional
 */
export function parseArgs(args: string[], options: Record<string, OptionSpec>): ParsedArgs
{
    const by_short = new Map(Object.entries(options).filter(([, o]) => o.short).map(([name, o]) => [o.short!, name]));
    const positionals: string[] = [];
    const values: OptionValues = {};
    for (let i = 0; i < args.length; i++)
    {
        const a = args[i]!;
        if (a === "--")
        {
            positionals.push(...args.slice(i + 1));
            break;
        }
        if (!a.startsWith("-") || a === "-" || NEGATIVE_NUMBER.test(a))
        {
            positionals.push(a);
            continue;
        }
        let name: string;
        let inline: string | undefined;
        if (a.startsWith("--"))
        {
            const eq = a.indexOf("=");
            name = eq < 0 ? a.slice(2) : a.slice(2, eq);
            inline = eq < 0 ? undefined : a.slice(eq + 1);
        }
        else
        {
            if (a.length !== 2) throw new UsageError(`Unknown option ${a}. Short options are a single letter, such as -o`);
            const long = by_short.get(a[1]!);
            if (!long) throw new UsageError(`Unknown option ${a}`);
            name = long;
        }
        const spec = options[name];
        if (!spec) throw new UsageError(`Unknown option --${name}`);
        let value: string | boolean;
        if (spec.type === "boolean")
        {
            if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
            value = true;
        }
        else if (inline !== undefined) value = inline;
        else
        {
            if (i + 1 >= args.length) throw new UsageError(`--${name} needs a value`);
            value = args[++i]!;
        }
        if (spec.multiple) values[name] = [...((values[name] as string[] | undefined) ?? []), value as string];
        else values[name] = value;
    }
    return { positionals, values };
}

/** A number given as an option, such as --count 5, checked to be at least min */
export function numberOption(values: OptionValues, name: string, fallback: number, min = 0): number
{
    const v = values[name];
    if (v === undefined) return fallback;
    const n = Number(v);
    if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(n) || n < min) throw new UsageError(`--${name} must be a number of at least ${min}, not "${String(v)}"`);
    return n;
}

/** A whole number given as an option, such as --count 5 */
export function integerOption(values: OptionValues, name: string, fallback: number, min = 0): number
{
    const n = numberOption(values, name, fallback, min);
    if (!Number.isInteger(n)) throw new UsageError(`--${name} must be a whole number`);
    return n;
}

/** A string option, or undefined when not given */
export function stringOption(values: OptionValues, name: string): string | undefined
{
    const v = values[name];
    return typeof v === "string" ? v : undefined;
}

/** All the values of an option that can be given more than once */
export function listOption(values: OptionValues, name: string): string[]
{
    const v = values[name];
    return Array.isArray(v) ? v : [];
}
