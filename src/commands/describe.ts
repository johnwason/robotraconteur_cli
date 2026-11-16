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
import { parseServiceDefinition, RobotRaconteurNode, ServiceDefinitionParseError } from "robotraconteur";
import type { ServiceDefinition, ServiceStub } from "robotraconteur";
import { getElement, MessageElement } from "robotraconteur/internal";
import type { MessageEntry } from "robotraconteur/internal";
import { ServiceDefinitionVerifyError, verifyServiceDefinitionOrder, verifyServiceDefinitions } from "robotraconteur/validators";
import type { Command } from "../cli.js";
import { describeJson, describeText } from "../describe.js";
import { UsageError } from "../errors.js";

const describe: Command = {
    name: ["describe"],
    usage: "<target> [member]",
    summary: "Show the members of an object, or one member and the types it uses",
    details: "The output is in service definition syntax, or JSON with --json.",
    connects: true,
    minArgs: 1,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        if (ctx.out.json) ctx.out.value(describeJson(stub, ctx.args[1]));
        else ctx.out.text(describeText(stub, ctx.args[1]));
    }
};

interface RequestContext
{
    newEntry(type: number): MessageEntry;
    processRequest(m: MessageEntry): Promise<MessageEntry>;
}

/** GetServiceDesc, from the MessageEntryType of Core */
const GET_SERVICE_DESC = 101;

/**
 * The text of a service definition as the service sent it, with its comments and layout. The client
 * keeps only the parsed definitions, so it is requested again
 */
async function serviceDefinitionText(stub: ServiceStub, name: string): Promise<string>
{
    const context = stub.context as unknown as RequestContext;
    if (typeof context.newEntry !== "function") throw new Error("This version of the robotraconteur package cannot request service definitions");
    const e = context.newEntry(GET_SERVICE_DESC);
    e.addElement(MessageElement.string("ServiceType", name));
    e.addElement(MessageElement.string("clientversion", RobotRaconteurNode.Version));
    const ret = await context.processRequest(e);
    return getElement(ret.elements, "servicedef").castString();
}

function defsOf(stub: ServiceStub): ServiceDefinition[]
{
    return [...stub.context.types.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const robdefList: Command = {
    name: ["robdef", "list"],
    usage: "<target>",
    summary: "List the service definitions a service uses",
    connects: true,
    minArgs: 1,
    maxArgs: 1,
    async run(ctx)
    {
        const names = defsOf(await ctx.connect(ctx.args[0]!)).map((d) => d.name);
        if (ctx.out.json) ctx.out.value(names);
        else ctx.out.text(names.join("\n"));
    }
};

const robdefShow: Command = {
    name: ["robdef", "show"],
    usage: "<target> [name]",
    summary: "Print a service definition a service uses, by default that of its root object",
    details: "With --json, prints the parsed definition, as described by service-definition.schema.json in the robotraconteur package.",
    connects: true,
    minArgs: 1,
    maxArgs: 2,
    async run(ctx)
    {
        const stub = await ctx.connect(ctx.args[0]!);
        const name = ctx.args[1] ?? stub.objectType.substring(0, stub.objectType.lastIndexOf("."));
        const def = stub.context.types.defs.get(name);
        if (!def) throw new Error(`The service does not use a definition named "${name}". It uses: ${defsOf(stub).map((d) => d.name).join(", ")}`);
        if (ctx.out.json) ctx.out.value(def);
        else process.stdout.write((await serviceDefinitionText(stub, name)).replace(/\n*$/, "\n"));
    }
};

function readDefinition(path: string): { path: string; text: string; def: ServiceDefinition }
{
    let text: string;
    try
    {
        text = readFileSync(path, "utf8");
    }
    catch (e)
    {
        throw new UsageError(`Could not read ${path}: ${(e as Error).message}`);
    }
    try
    {
        return { path, text, def: parseServiceDefinition(text) };
    }
    catch (e)
    {
        if (e instanceof ServiceDefinitionParseError) throw new Error(`${path}: ${e.message}`);
        throw e;
    }
}

const robdefCheck: Command = {
    name: ["robdef", "check"],
    usage: "<file...>",
    summary: "Check service definition files, and the imports between them",
    details: "Give every file the definitions import. Does not connect to anything.",
    minArgs: 1,
    maxArgs: Infinity,
    async run(ctx)
    {
        const files = ctx.args.map(readDefinition);
        for (const f of files)
        {
            try
            {
                verifyServiceDefinitionOrder(f.text);
            }
            catch (e)
            {
                throw new Error(`${f.path}: ${(e as Error).message}`);
            }
        }
        const names = new Map<string, string>();
        for (const f of files)
        {
            const other = names.get(f.def.name);
            if (other) throw new Error(`${f.path} and ${other} both define ${f.def.name}`);
            names.set(f.def.name, f.path);
        }
        try
        {
            verifyServiceDefinitions(files.map((f) => f.def));
        }
        catch (e)
        {
            if (e instanceof ServiceDefinitionVerifyError) throw new Error(e.message);
            throw e;
        }
        if (ctx.out.json) ctx.out.value(files.map((f) => ({ path: f.path, name: f.def.name, ok: true })));
        else ctx.out.text(files.map((f) => `${f.path}: ${f.def.name} OK`).join("\n"));
    }
};

const robdefParse: Command = {
    name: ["robdef", "parse"],
    usage: "<file>",
    summary: "Print a service definition file as JSON",
    details: "The JSON is described by service-definition.schema.json in the robotraconteur package. Does not connect to anything.",
    minArgs: 1,
    maxArgs: 1,
    async run(ctx)
    {
        const { def } = readDefinition(ctx.args[0]!);
        process.stdout.write(JSON.stringify(def, null, ctx.out.json ? undefined : 2) + "\n");
    }
};

export const describeCommands = [describe, robdefList, robdefShow, robdefCheck, robdefParse];
