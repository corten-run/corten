#!/usr/bin/env python3
"""Bytes and blocks an idle connection holds, by extra.py's idle reading (DHAT, 600 connections
less 100 over 500), for five states of the connection: idle5.py <server binary> [reps]."""
import sys

import extra

extra.IDLE = {
    "after-get": ["get"],
    "after-sdelay1": ["sdelay1"],
    "after-sdelay1-x2": ["sdelay1", "sdelay1"],
    "after-sdelay1-x3": ["sdelay1", "sdelay1", "sdelay1"],
    "after-sdelay1-x3-get": ["sdelay1", "sdelay1", "sdelay1", "get"],
}
extra.idle(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 2)
