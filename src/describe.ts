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

// Adapted from robotraconteur_mcp src/describe.ts

import type { MemberDefinition, ServiceDefinition, ServiceStub, TypeDefinition } from "robotraconteur";
import { primitivesByName } from "robotraconteur/internal";
import type { TypeContext } from "robotraconteur/internal";
import { typeName } from "./codec.js";
import { membersOf, scopeOf } from "./connect.js";

const MAX_TYPES = 100;

/**
 * Documentation comments are reStructuredText, where indentation has meaning. Remove only the
 * indentation the lines share, usually the space after each ##, and the blank lines around them.
 */
export function doc(text: string): string
{
    const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
    const indents = lines.filter((l) => l.length > 0).map((l) => /^[ \t]*/.exec(l)![0].length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;
    return lines.map((l) => l.slice(common)).join("\n").replace(/^\n+|\n+$/g, "");
}

/** Documentation as ## comment lines */
function docLines(text: string | undefined, indent: string): string[]
{
    return text ? doc(text).split("\n").map((l) => `${indent}##${l ? " " + l : ""}`) : [];
}

/** A member as it is written in a service definition, such as function void teleport(double x, double y) */
export function memberLine(m: MemberDefinition): string
{
    const params = m.parameters ? `(${m.parameters.map((p) => `${typeName(p.type)} ${p.name}`).join(", ")})` : "";
    const modifiers = m.modifiers?.length ? ` [${m.modifiers.join(",")}]` : "";
    const type = m.type ? `${typeName(m.type)} ` : "";
    return `${m.kind} ${type}${m.name}${params}${modifiers}`;
}

function memberSummary(m: MemberDefinition): Record<string, unknown>
{
    const out: Record<string, unknown> = { kind: m.kind, name: m.name };
    if (m.type) out["type"] = typeName(m.type);
    if (m.parameters) out["parameters"] = m.parameters.map((p) => ({ name: p.name, type: typeName(p.type) }));
    if (m.modifiers?.length) out["modifiers"] = m.modifiers;
    if (m.docString) out["doc"] = doc(m.docString);
    return out;
}

interface NamedType
{
    kind: string;
    doc?: string;
    values?: { name: string; value: number; docString?: string }[];
    fields?: MemberDefinition[];
}

/** Collect a named type and every type it uses */
function collectTypes(t: TypeDefinition, scope: ServiceDefinition, types: TypeContext, out: Map<string, NamedType>): void
{
    if (out.size >= MAX_TYPES || t.type === "void" || t.type === "string" || t.type === "varvalue" || t.type === "varobject" || primitivesByName.has(t.type)) return;
    const r = types.resolve(t.type, scope);
    if (out.has(r.qualifiedName)) return;
    if (r.kind === "enum")
    {
        const e = r.def.enums.find((x) => r.qualifiedName.endsWith("." + x.name))!;
        out.set(r.qualifiedName, { kind: "enum", doc: e.docString, values: e.values });
        return;
    }
    if (r.kind === "object")
    {
        out.set(r.qualifiedName, { kind: "object" });
        return;
    }
    const entry = r.entry!;
    out.set(r.qualifiedName, { kind: r.kind, doc: entry.docString, fields: entry.members });
    for (const m of entry.members) collectTypes(m.type!, r.def, types, out);
}

function typesOf(stub: ServiceStub, m: MemberDefinition): Map<string, NamedType>
{
    const types = new Map<string, NamedType>();
    const scope = scopeOf(stub);
    if (m.type) collectTypes(m.type, scope, stub.context.types, types);
    for (const p of m.parameters ?? []) collectTypes(p.type, scope, stub.context.types, types);
    return types;
}

function typeJson(t: NamedType): Record<string, unknown>
{
    if (t.kind === "enum") return { kind: "enum", values: Object.fromEntries(t.values!.map((v) => [v.name, v.value])), ...(t.doc ? { doc: doc(t.doc) } : {}) };
    if (t.kind === "object") return { kind: "object" };
    return { kind: t.kind, ...(t.doc ? { doc: doc(t.doc) } : {}), fields: t.fields!.map((f) => ({ name: f.name, type: typeName(f.type!), ...(f.docString ? { doc: doc(f.docString) } : {}) })) };
}

function typeText(name: string, t: NamedType): string[]
{
    if (t.kind === "object") return [`object ${name}  # use --object to reach it`];
    const keyword = t.kind === "namedarray" ? "namedarray" : t.kind;
    const out = [...docLines(t.doc, ""), `${keyword} ${name}`];
    if (t.kind === "enum") out.push(...t.values!.flatMap((v) => [...docLines(v.docString, "    "), `    ${v.name} = ${v.value}`]));
    else out.push(...t.fields!.flatMap((f) => [...docLines(f.docString, "    "), `    field ${typeName(f.type!)} ${f.name}`]));
    out.push("end");
    return out;
}

function findMember(stub: ServiceStub, member: string): MemberDefinition
{
    const members = membersOf(stub);
    const m = members.find((x) => x.name === member);
    if (!m) throw new Error(`${stub.objectType} has no member "${member}". Its members are: ${members.map((x) => x.name).join(", ")}`);
    return m;
}

/** Describe an object, or one of its members along with the types needed to use it, as JSON */
export function describeJson(stub: ServiceStub, member?: string): Record<string, unknown>
{
    const scope = scopeOf(stub);
    const short_name = stub.objectType.substring(stub.objectType.lastIndexOf(".") + 1);
    const entry = scope.objects.find((o) => o.name === short_name)!;
    if (member === undefined)
    {
        return {
            objectType: stub.objectType,
            ...(entry.implements.length ? { implements: entry.implements } : {}),
            ...(scope.docString ? { serviceDoc: doc(scope.docString) } : {}),
            ...(entry.docString ? { doc: doc(entry.docString) } : {}),
            members: entry.members.map(memberSummary)
        };
    }
    const m = findMember(stub, member);
    const types = typesOf(stub, m);
    return {
        objectType: stub.objectType,
        member: memberSummary(m),
        types: Object.fromEntries([...types].map(([k, t]) => [k, typeJson(t)])),
        ...(types.size >= MAX_TYPES ? { truncated: true } : {})
    };
}

/** Describe an object, or one of its members and the types it uses, in service definition syntax */
export function describeText(stub: ServiceStub, member?: string): string
{
    const scope = scopeOf(stub);
    const short_name = stub.objectType.substring(stub.objectType.lastIndexOf(".") + 1);
    const entry = scope.objects.find((o) => o.name === short_name)!;
    if (member === undefined)
    {
        const out = [...docLines(entry.docString, ""), `object ${stub.objectType}`];
        out.push(...entry.implements.map((i) => `    implements ${i}`));
        for (const m of entry.members) out.push(...docLines(m.docString, "    "), `    ${memberLine(m)}`);
        out.push("end");
        return out.join("\n");
    }
    const m = findMember(stub, member);
    const out = [...docLines(m.docString, ""), memberLine(m)];
    const types = typesOf(stub, m);
    for (const [name, t] of types) out.push("", ...typeText(name, t));
    if (types.size >= MAX_TYPES) out.push("", `# Only the first ${MAX_TYPES} types are shown`);
    return out.join("\n");
}
