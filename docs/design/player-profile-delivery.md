# Player profiles and achievements delivery

Approved 3 October 2026. This is implementation work in progress, not a deployment
or readiness claim. The [approved brief](player-profile-brief.md) supersedes the
design study's unresolved decisions and 19-class launch scope.

## Work items

| Backlog | GitHub | Responsibility |
| --- | --- | --- |
| M3-14 | [#199](https://github.com/ajfisher/3fc/issues/199) | Approved scope, shared catalogue and contracts |
| M3-08 | [#139](https://github.com/ajfisher/3fc/issues/139) | Existing complete linked-history foundation and participant home |
| M3-06 | [#37](https://github.com/ajfisher/3fc/issues/37) | Existing profile statistics and paginated match log |
| M3-10 | [#200](https://github.com/ajfisher/3fc/issues/200) | History projections, work pipeline and backfill |
| M3-11 | [#201](https://github.com/ajfisher/3fc/issues/201) | All 23 achievement rules and correction-safe unlock history |
| M3-13 | [#202](https://github.com/ajfisher/3fc/issues/202) | Verified-owner name/photo editing and private media |
| M3-12 | [#203](https://github.com/ajfisher/3fc/issues/203) | Club Card export and in-app achievement gallery |

M3-08 remains a dependency, not presumed complete. Its history foundation is
reactivated by this build; its participant-home scope remains tracked separately.
No projection-only PR will claim to close all of #139. Likewise #37 is closed only
when its full profile/history responsibilities are delivered. Current-main review
at fa7e775 found no newer profile/history implementation to duplicate.

## Stack and gates

1. Scope, catalogue, milestone arithmetic and safe presentation contracts (#199):
   in progress. Excludes the evaluator and all runtime endpoints/UI.
2. Pure evaluator for all 23 classes (#201): pending.
3. Complete canonical history, durable work pipeline, persistence and resumable
   backfill (#139 foundation, #200, remainder of #201): pending; split infrastructure
   and mutation integration further if needed for reviewability.
4. Authorised profile/history routes and owner name/photo/media (#37, #202): pending.
5. Profile UI, card/export and achievement gallery (#37, #203): pending.
6. Serialised QA coverage verification and feature activation: pending.

Each child PR bases on the preceding reviewed PR. Before starting the next slice:
complete independent sub-agent reviews, address findings, run focused validation,
then obtain a completed passing review gate for that slice's current head. Review
agents remain read-only and do not launch tests; the primary agent serialises local
validation under the 4 GiB process-tree ceiling. QA deployments are serialised.
Record each PR and evidence here as created. No PR has yet been opened.

AJ retains merge and production-release authority. All new capabilities remain
behind separate profiles, owner-editing and achievements flags until coverage and
QA gates pass. No mock portrait, demo account or fixture statistics ship as defaults.

## Architecture

The canonical scoring record remains authoritative. Profiles use revision-fenced
read projections; no browser league-history fan-out. Source mutations atomically
record durable work. A Streams dispatcher delivers SQS work to a bounded worker.
Season/career history and achievements share canonical identity and contribution
facts. Every milestone has durable evidence and correction history.

Owner writes are separate from league management. Private account fields never
enter performance projections or exports. Portraits are validated, re-encoded
and held in private storage. See [ADR 0002](../decisions/0002-player-profile-authority-and-achievements.md).
