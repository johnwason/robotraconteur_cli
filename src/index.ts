#!/usr/bin/env node
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


import { main } from "./cli.js";
import { describeCommands } from "./commands/describe.js";
import { discoverCommands } from "./commands/discover.js";
import { memberCommands } from "./commands/members.js";

const commands = [...discoverCommands, ...describeCommands, ...memberCommands];

const code = await main(commands, process.argv.slice(2));
// Transports and timers of the node may still be open, so leave once the output is written
process.stdout.write("", () => process.exit(code));
