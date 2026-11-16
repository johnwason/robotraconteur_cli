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

/** The command line was not valid. Reported with the usage of the command, and exit code 2 */
export class UsageError extends Error
{
    constructor(message: string)
    {
        super(message);
        this.name = "UsageError";
    }
}

/** The text of an error, as printed */
export function errorText(e: unknown): string
{
    if (e instanceof RobotRaconteurError)
    {
        const hint = e.errorName === "RobotRaconteur.ObjectLockedError" ? " The object is locked by another client." : "";
        return `${e.errorName}${e.message ? `: ${e.message.replace(/\.$/, "")}` : ""}.${hint}`;
    }
    return e instanceof Error ? e.message : String(e);
}
