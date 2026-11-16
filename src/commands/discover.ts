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

import type { ServiceInfo2 } from "robotraconteur-node";
import { listOption, numberOption, stringOption } from "../args.js";
import type { OptionSpec } from "../args.js";
import type { Command } from "../cli.js";
import { isServiceIndex, serviceLabel } from "../connect.js";
import { columns, formatText } from "../format.js";

const WAIT: OptionSpec = { type: "string", short: "w", value: "SECONDS", description: "How long to search (default 3)" };
const VERBOSE: OptionSpec = { type: "boolean", short: "v", description: "Also show URLs, implemented types, and attributes" };
const ALL: OptionSpec = { type: "boolean", description: "Include RobotRaconteurServiceIndex, which every node has" };
const IPV4: OptionSpec = { type: "boolean", description: "Also search with IPv4 broadcast, as well as IPv6 multicast" };

function plain(v: unknown): unknown
{
    if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), plain(x)]));
    if (Array.isArray(v)) return v.map(plain);
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<unknown>, plain);
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null && "value" in v && "type" in v) return plain((v as { value: unknown }).value);
    return v;
}

function serviceJson(s: ServiceInfo2): Record<string, unknown>
{
    return {
        name: serviceLabel(s),
        service: s.name,
        nodeName: s.nodeName,
        nodeID: s.nodeID.toString(),
        type: s.rootObjectType,
        implements: s.rootObjectImplements,
        urls: s.connectionURLs,
        attributes: plain(s.attributes)
    };
}

function printServices(list: ServiceInfo2[], verbose: boolean): string
{
    if (!verbose) return columns(list.map((s) => [serviceLabel(s), s.rootObjectType]));
    return list.map((s) =>
    {
        const j = serviceJson(s);
        delete j.name;
        return `${serviceLabel(s)}\n${formatText(j).split("\n").map((l) => "  " + l).join("\n")}`;
    }).join("\n\n");
}

function sorted(list: ServiceInfo2[]): ServiceInfo2[]
{
    return [...list].sort((a, b) => serviceLabel(a).localeCompare(serviceLabel(b)));
}

const discover: Command = {
    name: ["discover"],
    usage: "",
    summary: "Find the services on the network",
    details: `Searches with IPv6 link-local multicast, and IPv4 broadcast with --ipv4. Each service is shown
by the name other commands accept, node/service, and its root object type.`,
    options: {
        type: { type: "string", multiple: true, value: "TYPE", description: "Only services whose root object is or implements this type" },
        node: { type: "string", short: "n", value: "NAME", description: "Only services of this node, by name or ID" },
        wait: WAIT,
        verbose: VERBOSE,
        all: ALL,
        ipv4: IPV4
    },
    minArgs: 0,
    maxArgs: 0,
    async run(ctx)
    {
        const node = stringOption(ctx.values, "node");
        let list = await ctx.session().searchServices(numberOption(ctx.values, "wait", 3) * 1000, listOption(ctx.values, "type"));
        if (node !== undefined) list = list.filter((s) => s.nodeName === node || s.nodeID.toString().replace(/[{}]/g, "") === node.replace(/[{}]/g, ""));
        list = sorted(ctx.values.all ? list : list.filter((s) => !isServiceIndex(s)));
        if (ctx.out.json) ctx.out.value(list.map(serviceJson));
        else if (list.length === 0) process.stderr.write("No services found\n");
        else ctx.out.text(printServices(list, ctx.values.verbose === true));
    }
};

const nodeList: Command = {
    name: ["node", "list"],
    usage: "",
    summary: "Find the nodes on the network",
    options: { wait: WAIT, ipv4: IPV4 },
    minArgs: 0,
    maxArgs: 0,
    async run(ctx)
    {
        const nodes = (await ctx.session().searchNodes(numberOption(ctx.values, "wait", 3) * 1000))
            .map((n) => ({ nodeName: n.nodeName, nodeID: n.nodeID.toString(), urls: n.urls.map((u) => u.url) }))
            .sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.nodeID.localeCompare(b.nodeID));
        if (ctx.out.json) ctx.out.value(nodes);
        else if (nodes.length === 0) process.stderr.write("No nodes found\n");
        else ctx.out.text(columns(nodes.map((n) => [n.nodeName || "(no name)", n.nodeID])));
    }
};

const nodeInfo: Command = {
    name: ["node", "info"],
    usage: "<node>",
    summary: "Show a node's ID, URLs, and services",
    details: "<node> is a node name or node ID.",
    options: { wait: WAIT, verbose: VERBOSE, all: ALL, ipv4: IPV4 },
    minArgs: 1,
    maxArgs: 1,
    async run(ctx)
    {
        const name = ctx.args[0]!;
        const id = name.replace(/[{}]/g, "").toLowerCase();
        const matches = (n: { nodeName: string; nodeID: { toString(): string } }) => n.nodeName === name || n.nodeID.toString().replace(/[{}]/g, "").toLowerCase() === id;
        const session = ctx.session();
        const wait = numberOption(ctx.values, "wait", 3) * 1000;
        const services = sorted((await session.searchServices(wait)).filter((s) => matches(s) && (ctx.values.all || !isServiceIndex(s))));
        const nodes = (await session.searchNodes(0)).filter(matches);
        if (nodes.length === 0 && services.length === 0) throw new Error(`Node "${name}" was not found`);
        if (new Set(nodes.map((n) => n.nodeID.toString())).size > 1) throw new Error(`More than one node is named "${name}": ${nodes.map((n) => n.nodeID.toString()).join(", ")}. Use its ID`);
        const node = nodes[0];
        const info = {
            nodeName: node?.nodeName ?? services[0]!.nodeName,
            nodeID: (node?.nodeID ?? services[0]!.nodeID).toString(),
            urls: node?.urls.map((u) => u.url) ?? [],
            services: services.map(serviceJson)
        };
        if (ctx.out.json)
        {
            ctx.out.value(info);
            return;
        }
        ctx.out.text(formatText({ nodeName: info.nodeName, nodeID: info.nodeID, urls: info.urls }));
        ctx.out.text(services.length === 0 ? "services: []" : "services:\n" + printServices(services, ctx.values.verbose === true).split("\n").map((l) => "  " + l).join("\n"));
    }
};

export const discoverCommands = [discover, nodeList, nodeInfo];
