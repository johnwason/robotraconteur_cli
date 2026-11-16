#!/usr/bin/env python3
"""A service with every kind of member rrac uses, for the integration tests.

position sends a counter at 50 Hz, numbers sends 0, 1, 2, ... at 20 Hz, and fire sends the
message event. It runs until its stdin closes."""
import argparse
import sys
import threading
import time

import numpy as np
import RobotRaconteur as RR

RRN = RR.RobotRaconteurNode.s

_robdef = """
## Test service for rrac
service experimental.rrac_test

stdver 0.10

enum Mode
    idle = 0,
    run = 1
end

## A point in the plane
struct Point
    ## The x coordinate
    field double x
    field double y
end

object Arm
    property string name [readonly]
end

## The root object
object TestObject
    ## A counter
    property int32 counter
    property double[] values
    property Point point
    property Mode mode
    property int64 big
    function double add(double a, double b)
    function string echo(string s)
    function void fire(string text, int32 n)
    function int32{generator} count_to(int32 n)
    function double{generator} accumulate(double{generator} x)
    function void fail()
    function Point last_command()
    wire double[] position [readonly]
    wire Point command [writeonly]
    pipe int32 numbers [readonly]
    event message(string text, int32 n)
    objref Arm arm
    objref Arm{int32} arms
end
"""


class Arm:
    def __init__(self, name):
        self.name = name


class CountGenerator:
    def __init__(self, n):
        self._i = 0
        self._n = n

    def Next(self):
        if self._i >= self._n:
            raise RR.StopIterationException("")
        self._i += 1
        return self._i

    def Close(self):
        self._n = 0

    def Abort(self):
        self._n = 0


class AccumulateGenerator:
    def __init__(self):
        self._total = 0.0

    def Next(self, x):
        self._total += x
        return self._total

    def Close(self):
        pass

    def Abort(self):
        pass


class TestObject:
    def __init__(self):
        self.counter = 0
        self.values = np.array([1.0, 2.0, 3.0])
        self.point = RRN.NewStructure("experimental.rrac_test.Point")
        self.point.x = 1.5
        self.point.y = -2.0
        self.mode = 1
        self.big = 9007199254740993
        self.message = RR.EventHook()
        self._arm = Arm("main")
        self._arms = {0: Arm("left"), 1: Arm("right")}
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)

    def RRServiceObjectInit(self, context, service_path):
        self._thread.start()

    def _run(self):
        i = 0
        while self._running:
            time.sleep(0.02)
            i += 1
            self.position.OutValue = np.array([float(i), 0.5], dtype=np.float64)
            if i % 2 == 0:
                self.numbers.AsyncSendPacket(i // 2, lambda: None)

    def add(self, a, b):
        return a + b

    def echo(self, s):
        return s

    def fire(self, text, n):
        self.message.fire(text, n)

    def count_to(self, n):
        return CountGenerator(n)

    def accumulate(self):
        return AccumulateGenerator()

    def fail(self):
        raise RR.InvalidOperationException("fail was called")

    def last_command(self):
        try:
            return self.command.InValue[0]
        except Exception:
            return None

    def get_arm(self):
        return self._arm, "experimental.rrac_test.Arm"

    def get_arms(self, ind):
        return self._arms[int(ind)], "experimental.rrac_test.Arm"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=52720)
    parser.add_argument("--name", default="rrac_test")
    args, _ = parser.parse_known_args()
    with RR.ServerNodeSetup(args.name, args.port, argv=[sys.argv[0]]):
        RRN.RegisterServiceType(_robdef)
        RRN.RegisterService("test", "experimental.rrac_test.TestObject", TestObject())
        print(f"PORT {args.port}", flush=True)
        sys.stdin.read()


if __name__ == "__main__":
    main()
