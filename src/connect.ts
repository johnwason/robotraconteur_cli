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

import { RobotRaconteurError, RobotRaconteurNode } from "robotraconteur";
import type { MemberDefinition, ServiceDefinition, ServiceStub } from "robotraconteur";
import { IPNodeDiscoveryFlags, NodeDiscovery, TcpTransport } from "robotraconteur-node";
import type { NodeDiscoveryInfo, ServiceInfo2 } from "robotraconteur-node";
import { Codec } from "./codec.js";
import { UsageError } from "./errors.js";

export interface SessionOptions
{
    /** Milliseconds to allow for finding and connecting to a service */
    timeout: number;
    /** Milliseconds to allow for a request, such as a function call */
    requestTimeout: number;
    username?: string;
    password?: string;
    /** Also search using IPv4 broadcast, in addition to IPv6 link-local multicast */
    ipv4?: boolean;
}

/** How often to ask nodes to announce themselves while searching */
const SEARCH_POLL_MS = [0, 500, 1500, 3000];
const SEARCH_POLL_REPEAT_MS = 3000;
const CHECK_MS = 100;

function sleep(ms: number): Promise<void>
{
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, message: () => string): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const timer = setTimeout(() => reject(new Error(message())), ms);
        p.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

/** The name a discovered service is given on the command line: node name and service name */
export function serviceLabel(s: ServiceInfo2): string
{
    return `${s.nodeName || s.nodeID.toString()}/${s.name}`;
}

/** Whether a target is a URL rather than a name found by discovery */
export function isUrl(target: string): boolean
{
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/** Split a name such as Reynard/reynard into its node and service. A bare service name has no node */
export function parseServiceName(target: string): { node?: string; service: string }
{
    const slash = target.indexOf("/");
    if (slash < 0) return { service: target };
    const node = target.slice(0, slash);
    const service = target.slice(slash + 1);
    if (!node || !service || service.includes("/")) throw new UsageError(`"${target}" is not a service name. Use a URL, a service name, or node/service, such as Reynard/reynard`);
    return { node, service };
}

function nodeMatches(s: { nodeName: string; nodeID: { toString(): string } }, node: string): boolean
{
    const id = s.nodeID.toString().replace(/[{}]/g, "").toLowerCase();
    return s.nodeName === node || id === node.replace(/[{}]/g, "").toLowerCase();
}

/** Split an object path such as arm.tool[0] into names and indexes. A dot inside an index is part of the index */
export function parseObjectPath(path: string): { name: string; index?: number | string }[]
{
    if (path === "") return [];
    return path.split(/\.(?![^[]*\])/).map((part) =>
    {
        const m = /^([A-Za-z_]\w*)(?:\[(.*)\])?$/.exec(part);
        if (!m) throw new UsageError(`Invalid object path "${path}". Use names such as arm or tool[0], separated by dots`);
        const index = m[2];
        return { name: m[1]!, index: index === undefined ? undefined : /^-?\d+$/.test(index) ? Number(index) : index };
    });
}

/** The service definition an object's type belongs to */
export function scopeOf(stub: ServiceStub): ServiceDefinition
{
    return stub.context.serviceDefForType(stub.objectType);
}

export function codecOf(stub: ServiceStub): Codec
{
    return new Codec(stub.context.types);
}

/** The members of an object */
export function membersOf(stub: ServiceStub): MemberDefinition[]
{
    const short_name = stub.objectType.substring(stub.objectType.lastIndexOf(".") + 1);
    return scopeOf(stub).objects.find((o) => o.name === short_name)?.members ?? [];
}

const COMMAND_FOR_KIND: Record<string, string> = {
    property: "rrac property get or rrac property set",
    function: "rrac function call",
    wire: "rrac wire peek, echo, hz, or poke",
    pipe: "rrac pipe echo",
    event: "rrac event echo",
    objref: "--object"
};

/** Find a member of the kinds a command works with, explaining any mismatch */
export function memberOf(stub: ServiceStub, name: string, kinds: string[]): MemberDefinition
{
    const m = stub.context.findMember(stub.objectType, name);
    if (m && kinds.includes(m.kind)) return m;
    if (m) throw new Error(`"${name}" is a ${m.kind}, not a ${kinds.join(" or ")}.${COMMAND_FOR_KIND[m.kind] ? ` Use ${COMMAND_FOR_KIND[m.kind]}.` : ""}`);
    const names = membersOf(stub).filter((x) => kinds.includes(x.kind)).map((x) => x.name);
    throw new Error(`${stub.objectType} has no ${kinds.join(" or ")} named "${name}".${names.length > 0 ? ` Its ${kinds.join(" and ")} members are: ${names.join(", ")}` : ""}`);
}

/** A Robot Raconteur node for the duration of one command, with discovery started when needed */
export class Session
{
    readonly node = new RobotRaconteurNode();
    readonly tcp = new TcpTransport(this.node);
    private discovery_: NodeDiscovery | undefined;
    private discovery_started: Promise<void> | undefined;

    constructor(readonly options: SessionOptions)
    {
        this.node.requestTimeout = options.requestTimeout;
        this.node.registerTransport(this.tcp);
    }

    private get discovery(): NodeDiscovery
    {
        if (!this.discovery_)
        {
            this.discovery_ = new NodeDiscovery(this.node, this.tcp, {
                flags: IPNodeDiscoveryFlags.LinkLocal | (this.options.ipv4 ? IPNodeDiscoveryFlags.IPv4Broadcast : 0)
            });
            this.discovery_started = this.discovery_.start();
        }
        return this.discovery_;
    }

    /**
     * Search for services for up to wait milliseconds, or until done says enough has been found.
     * Nodes are asked to announce themselves several times during the search
     */
    async searchServices(wait: number, types: string[] = [], done?: (found: ServiceInfo2[]) => boolean): Promise<ServiceInfo2[]>
    {
        const discovery = this.discovery;
        await this.discovery_started;
        const found = discovery.subscribeServiceInfo2(types);
        try
        {
            const start = Date.now();
            let next_poll = 0;
            for (;;)
            {
                const elapsed = Date.now() - start;
                const last = SEARCH_POLL_MS.length - 1;
                const due = next_poll <= last ? SEARCH_POLL_MS[next_poll]! : SEARCH_POLL_MS[last]! + (next_poll - last) * SEARCH_POLL_REPEAT_MS;
                if (elapsed >= due)
                {
                    this.tcp.sendDiscoveryRequest();
                    next_poll++;
                }
                const list = found.getDetectedServiceInfo2();
                if (elapsed >= wait || done?.(list)) return list;
                await sleep(Math.min(CHECK_MS, wait - elapsed));
            }
        }
        finally
        {
            found.close();
        }
    }

    /** The nodes seen after searching for wait milliseconds */
    async searchNodes(wait: number): Promise<NodeDiscoveryInfo[]>
    {
        await this.searchServices(wait);
        return this.discovery.detectedNodes;
    }

    /** Find one service by name, as node/service or a service name that only one node has */
    async findService(target: string): Promise<ServiceInfo2>
    {
        const { node, service } = parseServiceName(target);
        const matching = (list: ServiceInfo2[]) => list.filter((s) => s.name === service && (node === undefined || nodeMatches(s, node)));
        // Without a node, keep looking for a while after the first match, so that a second node with the same service is noticed
        let first_match: number | undefined;
        const list = await this.searchServices(this.options.timeout, [], (l) =>
        {
            if (matching(l).length === 0) return false;
            if (node !== undefined) return true;
            first_match ??= Date.now();
            return Date.now() - first_match >= 1000;
        });
        const found = matching(list);
        if (found.length === 1) return found[0]!;
        if (found.length > 1) throw new UsageError(`More than one node has a service named "${service}": ${found.map(serviceLabel).join(", ")}. Give the node, such as ${serviceLabel(found[0]!)}`);
        const known = list.map(serviceLabel);
        throw new Error(`Service "${target}" was not found within ${this.options.timeout / 1000} s. ${known.length > 0 ? `Found: ${known.join(", ")}` : "No services were found. Check that the service is running, or give its URL."}`);
    }

    /** Connect to a service by URL or name, then select a sub object if a path is given */
    async connect(target: string, object?: string): Promise<ServiceStub>
    {
        const urls = isUrl(target) ? [target] : (await this.findService(target)).connectionURLs;
        const credentials = this.options.password === undefined ? undefined : new Map<string, unknown>([["password", this.options.password]]);
        const root = await withTimeout(this.node.connectService(urls, this.options.username, credentials), this.options.timeout,
            () => `Could not connect to ${target} within ${this.options.timeout / 1000} s`).catch((e: unknown) =>
        {
            if (e instanceof RobotRaconteurError && e.errorName === "RobotRaconteur.ConnectionError") throw new Error(`Could not connect to ${target}: ${e.message}`);
            throw e;
        });
        let o = root;
        for (const part of parseObjectPath(object ?? "")) o = await o.getObjRef(part.name, part.index);
        return o;
    }

    async close(): Promise<void>
    {
        this.discovery_?.close();
        await withTimeout(this.node.shutdown(), 2000, () => "shutdown timed out").catch(() => undefined);
    }
}
