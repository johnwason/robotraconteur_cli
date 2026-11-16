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

import type { TimeSpec } from "robotraconteur";

/** Where results are written, and how */
export interface OutputOptions
{
    /** Print JSON, one value per line, instead of text for people */
    json: boolean;
    /** Arrays longer than this are shortened in text output */
    maxArray?: number;
}

/** Strings that YAML would read as something else are quoted, so the output stays unambiguous */
function plainString(s: string): string
{
    if (s === "" || /^[\s\-?:,[\]{}#&*!|>'"%@`]|[\n\r\t]|:\s|\s#|\s$/.test(s) || /^(null|true|false|~|[-+.\d].*)$/i.test(s)) return JSON.stringify(s);
    return s;
}

function scalar(v: unknown): string
{
    if (v === null || v === undefined) return "null";
    if (typeof v === "string") return plainString(v);
    if (typeof v === "bigint") return v.toString();
    return String(v);
}

function isScalar(v: unknown): boolean
{
    return v === null || typeof v !== "object";
}

function shortened(a: unknown[], max: number | undefined): { items: unknown[]; more: number }
{
    if (max === undefined || a.length <= max) return { items: a, more: 0 };
    return { items: a.slice(0, max), more: a.length - max };
}

function lines(v: unknown, indent: string, max: number | undefined, out: string[]): void
{
    if (Array.isArray(v))
    {
        const { items, more } = shortened(v, max);
        for (const x of items)
        {
            if (isScalar(x) || (Array.isArray(x) && x.every(isScalar))) out.push(`${indent}- ${inline(x, max)}`);
            else
            {
                const nested: string[] = [];
                lines(x, indent + "  ", max, nested);
                if (nested.length > 0) nested[0] = `${indent}- ${nested[0]!.trimStart()}`;
                else nested.push(`${indent}- ${Array.isArray(x) ? "[]" : "{}"}`);
                out.push(...nested);
            }
        }
        if (more > 0) out.push(`${indent}# ... ${more} more`);
        return;
    }
    if (typeof v === "object" && v !== null)
    {
        for (const [k, x] of Object.entries(v))
        {
            const key = plainString(k);
            const empty = (Array.isArray(x) && x.length === 0) || (typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length === 0);
            if (isScalar(x) || empty || (Array.isArray(x) && x.every(isScalar))) out.push(`${indent}${key}: ${inline(x, max)}`);
            else
            {
                out.push(`${indent}${key}:`);
                lines(x, indent + "  ", max, out);
            }
        }
        return;
    }
    out.push(indent + scalar(v));
}

/** A scalar, an empty container, or an array of scalars, on one line */
function inline(v: unknown, max: number | undefined): string
{
    if (Array.isArray(v))
    {
        const { items, more } = shortened(v, max);
        return `[${items.map(scalar).join(", ")}${more > 0 ? `, ... ${more} more` : ""}]`;
    }
    if (typeof v === "object" && v !== null) return "{}";
    return scalar(v);
}

/** Text for people, in the style of YAML, of a value already converted to JSON */
export function formatText(v: unknown, maxArray?: number): string
{
    if (isScalar(v)) return scalar(v);
    if (Array.isArray(v) && v.every(isScalar)) return inline(v, maxArray);
    const out: string[] = [];
    lines(v, "", maxArray, out);
    return out.length > 0 ? out.join("\n") : inline(v, maxArray);
}

/** A Robot Raconteur time as seconds since the epoch, with the nanoseconds as a decimal fraction */
export function formatTime(t: TimeSpec): string
{
    return `${t.seconds.toString()}.${String(t.nanoseconds).padStart(9, "0")}`;
}

/** Writes values in the chosen format */
export class Output
{
    constructor(readonly options: OutputOptions) {}

    get json(): boolean
    {
        return this.options.json;
    }

    /** A value already converted to JSON, as text in the chosen format */
    format(v: unknown): string
    {
        return this.options.json ? JSON.stringify(v) : formatText(v, this.options.maxArray);
    }

    /** Print a value already converted to JSON */
    value(v: unknown): void
    {
        process.stdout.write((this.options.json ? JSON.stringify(v) : formatText(v, this.options.maxArray)) + "\n");
    }

    /** Print text for people. Nothing is printed in JSON mode */
    text(s: string): void
    {
        if (!this.options.json) process.stdout.write(s + "\n");
    }

    /** Print a value in JSON mode, or text in text mode */
    either(json: unknown, text: string): void
    {
        process.stdout.write((this.options.json ? JSON.stringify(json) : text) + "\n");
    }
}

/** Lay out rows of text in columns, padded to the widest entry of each */
export function columns(rows: string[][]): string
{
    const widths: number[] = [];
    for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
    return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")).join("\n");
}
