# PBEcast ↔ QB DNA — documented, NOT built

Per the directive: keep Arcade and QB DNA separate until both are independently
approved. **Nothing in this file is implemented.** It exists so the eventual
connection is designed before it is wired, not discovered afterwards.

The two prototypes live on separate branches and share no code:

* `prototype/arcade-replay` — PBEcast Arcade Replay
* `prototype/nfl-data-harvest` — the warehouse and QB DNA (this branch)

## The one thing that makes a connection possible

Both sides already resolve to the **same identity spine**. Arcade normalises a
live ESPN play; QB DNA resolves a live ESPN athlete id to a GSIS identity
deterministically, and that is tested. So the join is:

```
ESPN athlete id  ──(nfl_player_identity)──→  GSIS id  ──→  QB DNA history
```

No new identity work is required. That is the whole reason the crosswalk was
built first.

## What a connection could truthfully do

| capability | truthful today? | why |
|---|---|---|
| show the passer's season and career baseline beside a live play | **yes** | the passer is named in the play text; once resolved to a stable id, everything QB DNA serves applies |
| show his history in *this game's* conditions | **yes** | `/api/qb-dna/game-context` already resolves the real venue, roof and forecast for a scheduled game |
| show whether a live passing-yards total is tracking over or under his own history | **yes** | `prop-history` counts completed games; the live total is a separate, clearly-labelled figure |
| label a reconstructed route with the receiver's actual usage | **no** | ESPN publishes no participants on a play (0 of 192 on a completed game, 0 across 10,832 plays) |
| drive the reconstruction itself from QB DNA | **never** | history must not shape what a replay claims happened. The replay renders the play; QB DNA sits beside it as context. |

## The rule the connection must not break

Arcade's truth contract says the outcome and known field states are exact and
the intermediate movement is reconstructed. QB DNA's contract says every figure
is counted and carries its N.

**Combining them must not let either claim leak into the other.** Specifically:

* a QB DNA figure placed next to a replay must stay visibly a *historical*
  figure, with its N, and must never be styled as part of the play
* a reconstructed element must never be annotated with a historical rate in a
  way that implies the rate was measured on that play
* a live in-progress total is neither: it is a fourth provenance class and needs
  its own label, distinct from `SOURCE_FACT` and `DERIVED`

## Suggested shape, when both are approved

A context rail beside the replay, not an overlay on it:

```
┌──────────────────────────┬─────────────────────────┐
│  ARCADE REPLAY           │  QB DNA · CONTEXT       │
│  (the play)              │  P.Mahomes              │
│                          │  career 282.6 y/g N=114 │
│  RECONSTRUCTED FROM      │  tonight's conditions:  │
│  LIVE PLAY-BY-PLAY       │  warm 70+  315.2  N=23  │
│                          │  wind 10+  271.3  N=37  │
│                          │  ── counted history ──  │
└──────────────────────────┴─────────────────────────┘
```

Two panels, two contracts, one identity. Neither borrows the other's authority.

## Prerequisites before any of this is built

1. Arcade approved on its own.
2. QB DNA approved on its own.
3. A fourth provenance label for live in-progress figures, agreed and specified.
4. A decision on whether the rail is allowed on a live game at all, or only on
   the post-game replay — the live path adds a per-snap identity resolution that
   has to be cheap and must fail closed.
