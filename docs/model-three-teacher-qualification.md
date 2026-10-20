# Teacher development qualification

The authored v2 teacher completed **4/4 natural wins**, with **zero rejected commands, fatal errors or timeouts**, against the weak native baseline on development seeds 93001 and 93002 in both policy roles. Its 475 commands passed 950 actor privacy checks. These cases are excluded from training and are separate from the frozen final evaluation. The opponent is not the official Live AI.

The earlier v1 teacher also won all four cases. These repeated development cases establish no statistical, strategic-strength or performance improvement. Both versions had zero evolution opportunities passed over by choosing attack or pass.

| Teacher | Seed | Policy role | Evolution offered/chosen | Recon offered/chosen | Phantom Dives | First Dive counter |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| v1 | 93001 | human | 6/4 | 4/4 | 5 | 8 |
| v1 | 93001 | opponent | 9/6 | 6/6 | 4 | 5 |
| v1 | 93002 | human | 9/7 | 13/13 | 5 | 16 |
| v1 | 93002 | opponent | 10/7 | 11/11 | 3 | 11 |
| v2 | 93001 | human | 7/4 | 13/12 | 4 | 8 |
| v2 | 93001 | opponent | 9/6 | 6/6 | 4 | 5 |
| v2 | 93002 | human | 9/7 | 13/13 | 5 | 16 |
| v2 | 93002 | opponent | 10/7 | 11/11 | 3 | 11 |

“Offered” counts ordinary decision states with a matching action, so repeated offers can count again. The first Dive counter is the **zero-based global turn counter across both players**, not the teacher's own-turn number. Diagnostics describe behavior, not reward or strength.

The self-contained generated teacher matched the original v2 teacher's complete ordered candidate streams on **all 301 retained qualification views**. The original authored v2 module SHA-256 is `f4a49302c35f72fe3f3bc90ee72859954becc0bd57f972790612284910814784`; this identifies the qualification module, not the generated wrapper containing the public factory and private scalar catalog.

A clean source archive at `f7b44f1` passed preparation and phase-plan generation with explicitly supplied private prerequisites. The operator reported 14 passing focused tests; the rehearsal receipt records preparation and plans without a test count. No games or GPU training ran in that rehearsal, and worker construction was not verified. The prepared native Release worker/runtime and authorized 39-program bundle, including exact JTG-120 and eight pinned files, remain external prerequisites. See the [reproduction recipe](model-three-reproduction.md).

The [aggregate JSON](model-three-teacher-qualification.json) records per-case counts and hashes of retained evidence. It contains no raw actor views or private program data. Four weak-baseline development wins do not establish full Standard coverage, competitive strength or a zero-loss guarantee.
