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

import { readFileSync } from "node:fs";
import type { MemberDefinition, ServiceStub, TypeDefinition } from "robotraconteur";
import { CodecError } from "./codec.js";
import { codecOf, scopeOf } from "./connect.js";
import { UsageError } from "./errors.js";

/** JSON given as text, or as @file to read it from a file */
export function readJson(text: string, what: string): unknown
{
    let content = text;
    const path = text.startsWith("@") ? text.slice(1) : undefined;
    if (path !== undefined)
    {
        try
        {
            content = readFileSync(path, "utf8");
        }
        catch (e)
        {
            throw new UsageError(`Could not read ${path}: ${(e as Error).message}`);
        }
    }
    try
    {
        return JSON.parse(content);
    }
    catch (e)
    {
        throw new UsageError(`${path ?? what} is not valid JSON: ${(e as Error).message}`);
    }
}

function isPlainString(t: TypeDefinition): boolean
{
    return t.type === "string" && !t.array && !t.container;
}

/**
 * The JSON a value given on the command line stands for. A plain string needs no quotes, and nor
 * does an enum name. @file reads the JSON from a file, for large values
 */
export function parseCliJson(text: string, t: TypeDefinition): unknown
{
    if (isPlainString(t)) return text.startsWith("\"") ? JSON.parse(text) : text;
    if (text.startsWith("@")) return readJson(text, "the value");
    try
    {
        return JSON.parse(text);
    }
    catch
    {
        // An enum name, or text the codec reports as the wrong type
        return text;
    }
}

/** Convert a value given on the command line to a value of the type, reporting where it is wrong */
export function valueFromCli(stub: ServiceStub, text: string, t: TypeDefinition, what: string): unknown
{
    try
    {
        return codecOf(stub).fromJson(parseCliJson(text, t), t, scopeOf(stub), what);
    }
    catch (e)
    {
        if (e instanceof CodecError) throw new UsageError(e.message);
        throw e;
    }
}

/** Convert a JSON value to a value of the type, reporting where it is wrong */
export function valueFromJson(stub: ServiceStub, v: unknown, t: TypeDefinition, what: string): unknown
{
    try
    {
        return codecOf(stub).fromJson(v, t, scopeOf(stub), what);
    }
    catch (e)
    {
        if (e instanceof CodecError) throw new UsageError(e.message);
        throw e;
    }
}

/** Convert a received value to JSON */
export function valueToJson(stub: ServiceStub, v: unknown, t: TypeDefinition | undefined): unknown
{
    if (!t) return null;
    return codecOf(stub).toJson(v, t, scopeOf(stub));
}

/** The parameters of a function, without a generator parameter, which takes its values at each step */
export function plainParameters(m: MemberDefinition)
{
    return (m.parameters ?? []).filter((p) => p.type.container !== "generator");
}

/**
 * The arguments of a function call: one command line value per parameter, or all of them in --args
 * as a JSON array or an object keyed by parameter name
 */
export function functionArguments(stub: ServiceStub, m: MemberDefinition, positionals: string[], args_json: string | undefined): unknown[]
{
    const parameters = plainParameters(m);
    const signature = `${m.name}(${parameters.map((p) => p.name).join(", ")})`;
    if (args_json !== undefined)
    {
        if (positionals.length > 0) throw new UsageError("Give the arguments either as values or with --args, not both");
        const given = readJson(args_json, "--args");
        if (Array.isArray(given))
        {
            if (given.length !== parameters.length) throw new UsageError(`${signature} takes ${parameters.length} arguments but --args has ${given.length}`);
            return parameters.map((p, i) => valueFromJson(stub, given[i], p.type, p.name));
        }
        if (typeof given !== "object" || given === null) throw new UsageError("--args must be a JSON array, or an object keyed by parameter name");
        const named = given as Record<string, unknown>;
        for (const k of Object.keys(named))
        {
            if (!parameters.some((p) => p.name === k)) throw new UsageError(`${m.name} has no parameter "${k}". Its parameters are: ${parameters.map((p) => p.name).join(", ")}`);
        }
        return parameters.map((p) =>
        {
            if (!(p.name in named)) throw new UsageError(`--args is missing parameter "${p.name}" of ${signature}`);
            return valueFromJson(stub, named[p.name], p.type, p.name);
        });
    }
    if (positionals.length !== parameters.length) throw new UsageError(`${signature} takes ${parameters.length} ${parameters.length === 1 ? "argument" : "arguments"} but ${positionals.length} ${positionals.length === 1 ? "was" : "were"} given`);
    return parameters.map((p, i) => valueFromCli(stub, positionals[i]!, p.type, p.name));
}
