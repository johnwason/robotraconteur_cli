# robotraconteur-cli

`rrac` finds and uses [Robot Raconteur](https://github.com/robotraconteur/robotraconteur) services from the command line, much as the `ros2` command does for ROS 2. It is written in TypeScript on the pure TypeScript [robotraconteur](https://www.npmjs.com/package/robotraconteur) and [robotraconteur-node](https://www.npmjs.com/package/robotraconteur-node) packages, and needs only Node.js 22 or later.

```
npm install -g robotraconteur-cli
rrac discover
```

## Commands

| Command | What it does | ROS 2 equivalent |
|---|---|---|
| `rrac discover` | Find the services on the network | `ros2 node list` |
| `rrac node list` | Find the nodes on the network | `ros2 node list` |
| `rrac node info <node>` | A node's ID, URLs, and services | `ros2 node info` |
| `rrac describe <target> [member]` | The members of an object, or one member and the types it uses | `ros2 interface show` |
| `rrac robdef list <target>` | The service definitions a service uses | `ros2 interface list` |
| `rrac robdef show <target> [name]` | Print a service definition | `ros2 interface show` |
| `rrac robdef check <file...>` | Check service definition files, offline | |
| `rrac robdef parse <file>` | A service definition file as JSON, offline | |
| `rrac property get <target> <property>` | Read a property | `ros2 param get` |
| `rrac property set <target> <property> <value>` | Write a property | `ros2 param set` |
| `rrac function call <target> <function> [value...]` | Call a function, or run a generator | `ros2 service call` |
| `rrac wire peek <target> <wire>` | Read a wire once | `ros2 topic echo --once` |
| `rrac wire echo <target> <wire>` | Print each value a wire sends | `ros2 topic echo` |
| `rrac wire hz <target> <wire>` | How often a wire sends values | `ros2 topic hz` |
| `rrac wire poke <target> <wire> <value>` | Write a wire's out value once | `ros2 topic pub --once` |
| `rrac pipe echo <target> <pipe>` | Print each packet a pipe sends | `ros2 topic echo` |
| `rrac event echo <target> [event]` | Print events as they are sent | |

`rrac <command> --help` gives the options of each command.

## Targets

`<target>` is either:

- a service URL, such as `rr+tcp://localhost:29200?service=reynard`. `rr+tcp`, `rrs+tcp`, `rr+ws`, and `rr+wss` are supported;
- a service found on the network, as `node/service`, such as `experimental.reynard_the_robot/reynard`, or the service name alone if only one node has it. `rrac discover` lists these names.

Discovery uses IPv6 link-local multicast, as Robot Raconteur Core does. Add `--ipv4` to also use IPv4 broadcast.

`--object` (`-o`) selects a sub object reached through objrefs, such as `-o arm` or `-o "tools[1]"`. Each level is separated by a dot.

For a service that requires a login, give `--username`, and the password in the environment variable `RRAC_PASSWORD`, or another variable named by `--password-env`. The password is never given on the command line, where other users could see it.

## Values

Values are JSON, converted to the member's type using the service definition:

```
rrac property set robot speed 0.5
rrac property set robot joint_target "[0, 1.57, 0]"
rrac property set robot pose '{"position": {"x": 1, "y": 2, "z": 0}}'
rrac function call robot set_mode halt          # an enum, by name
rrac function call reynard say "hello world"    # strings need no quotes
rrac wire poke robot command @command.json      # @file reads the JSON from a file
```

- Structure fields that are left out get their default values.
- 64-bit integers are printed as strings, so that they keep every digit, and accepted as numbers or strings.
- Enums are printed as `{"value": 1, "name": "run"}`.
- Multidimensional arrays are `{"dims": [...], "array": [...]}`, with the array in column-major order.
- Negative numbers can be given without `--`, as in `rrac property set robot offset -1.5`.

A function takes one value per parameter, or all of them with `--args` as a JSON array or as an object keyed by parameter name:

```
rrac function call reynard teleport 0.1 -0.2
rrac function call reynard teleport --args '{"x": 0.1, "y": -0.2}'
```

A generator function is run to its end, printing each value it returns. `--count` closes it early. A generator that takes a value at each step is given the `--input` values in turn. Ctrl-C aborts the generator on the service.

## Output

Values are printed as YAML-style text for people. With `--json`, each value is printed as JSON on its own line, for `jq` and scripts:

```
rrac wire echo robot robot_state --json | jq '.value.joint_position'
```

Wire values printed with `--json` include the timestamp the service sent with them, in seconds since the epoch. `--max-array N` shortens long arrays in text output.

Streaming commands (`wire echo`, `wire hz`, `pipe echo`, `event echo`) run until Ctrl-C, or until `--count` values have been printed.

Exit codes are 0 for success, 1 for a failed operation, 2 for a command line error, and 130 for a command interrupted by Ctrl-C before it finished. A streaming command stopped with Ctrl-C exits with 0.

## Single file build

`npm run bundle` writes `dist-bundle/rrac.mjs`, which runs with Node.js alone and needs no `node_modules`, along with the licenses of the packages included in it.

## Development

Builds and tests run in a container on an isolated network:

```
podman build -t rr-ts-mcp-dev ../robotraconteur_mcp   # the base image, with Python Robot Raconteur
podman build -t rr-ts-cli-dev .
scripts/podman-run.sh npm test
```

The integration tests run `rrac` against `test/services/cli_test_service.py`, a Python service with each kind of member.

## License

Apache 2.0
