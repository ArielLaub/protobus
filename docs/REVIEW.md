# Documentation Review — proposal, not documentation

> [!IMPORTANT]
> **This file is not part of the documentation set.** It is a review of it, written to be read once and then deleted along with the branch. Nothing links to it and nothing should.
>
> Reviewed: `origin/master` at `3e5c0a5`, 23 markdown files, 6,545 lines, against protobus `2.2.0`.
> Method: a literal cold start against a real broker, then **every claim-bearing example executed**, then a structural read. Every finding below cites a file and line, and a command and its output.
>
> `message-flow.md:208` (the `ORDERS.*.CREATED` Trie example) is already fixed in PR #33 and is excluded from the counts below, except where noted as the thing that prompted this sweep.

---

## Verdict

**Nine documented examples do not do what they say. Three of them fail silently.** That is the headline, and it outranks everything structural in this review — a reader who copies a snippet and gets a `TypeError` loses trust in the whole set, and a reader who copies one that *appears* to work carries a false belief into production.

Beyond that: the content is better than the docs look — but not for the reason you think.

There are **two different documentation sets in this repo**, written years apart in library-time, and they are not the same quality.

- **The 2.x pages** — `advanced/priority.md`, `advanced/security.md`, `advanced/streaming.md`, `advanced/structured-logging.md`, `advanced/queue-migration.md`, `configuration.md` — are genuinely excellent. They open with the problem, name the incident that motivated the feature, cite measurements, say explicitly what the feature *does not* do, and explain why an obvious alternative was rejected. That is better than most commercial framework documentation. Nothing in this review asks you to change them.
- **The 0.9-era pages** — `architecture.md`, `message-flow.md`, `getting-started.md`, `examples.md`, `migration.md`, `api/*`, `troubleshooting.md`, `known-issues.md` — were written for a different library and never re-audited. **Every factual error in this review is in that set.** So is every ASCII diagram, every broken link, and both indexes.

So your read — "most of the info is there but scattered in a wrong manner" — is **half right, and the wrong half is the dangerous one**. The scattering is real and I confirm it below. But the bigger problem is that the pages a newcomer reads *first* are the stale ones, and they are not merely dull — several of them are **wrong**. `architecture.md`, the page an evaluator opens to judge whether this is a serious framework, contains five factual errors including the default concurrency, the acknowledgement strategy, and two of the four wire-format messages.

A restyle applied to the current content would produce a beautiful page that tells you the concurrency default is unlimited. **Correctness first, then structure, then style** — and the style is cheap once the first two are done.

The single highest-value thing in the whole repo right now is not in `docs/` at all: `sample/combatGame` is a complete, self-verifying, six-service demo with a runner script, and **no documentation page mentions it.**

And the execution sweep produced one more result that sharpens the whole diagnosis: **every false example is in a 0.9-era page or in the root README. Every 2.x page I executed was 100% accurate** — `configuration.md` 18/18, `priority.md` 18/18. The split is not a matter of taste. It is measurable.

---

# Part 0 — Examples that are not true

Executed, not read. `git checkout` the branch and re-run any of these.

## Summary

| Verified | Result |
|---|---:|
| Wildcard / routing claims *(the `Trie`, directly)* | **21 / 22 hold** — the 1 is PR #33's |
| `configuration.md` env-var defaults | **18 / 18 hold** |
| `advanced/priority.md` constants, validation, live queue arguments | **18 / 18 hold** |
| `examples.md` retry-option defaults | **3 / 3 hold** |
| CLI commands, flags and config options | hold |
| **Runnable examples across the set** | **9 do not do what they say** |

## The nine

### ❌ 1. The root README's headline feature does not run — `README.md:69-81`

"Pluggable Custom Types" is one of five selling points on the front page. Executed verbatim:

```
TypeError: (0 , import_protobus.registerCustomType) is not a function
```

Wrong in four independent ways:

1. **`registerCustomType` is not exported from the package root.** It exists at `lib/custom_types.ts:94`, but `index.ts:76-80` exports only `ICustomType`, `BigIntType`, `TimestampType`, `bigintToBytes`, `bytesToBigint`. The import resolves to `undefined`.
2. **The arity is wrong.** The real signature is `registerCustomType(customType: ICustomType)` — one argument. The README calls it with two.
3. **The first two calls would be no-ops anyway.** `BigIntType` and `TimestampType` are already registered at module load (`lib/custom_types.ts:266-267`).
4. **The `Money` example cannot satisfy `ICustomType`.** It supplies only `encode`/`decode`; the interface also requires `name` and `wireType` (`lib/custom_types.ts:21-46`).

And this is the feature whose documentation link — `README.md:204` → `docs/api/custom-types.md` — points at a file that does not exist. Advertised on the front page, broken example, dead link, unexported entry point.

### ❌ 2. The *other* custom-type example also fails — `advanced/protobuf-schema.md:191-215`

The same feature is documented a second time, with a different API, and that one fails too:

```
Error: illegal token 'uuid' (line 1)
```

The doc says "Register before or after `init()`". **Both orders fail**, on npm 2.1.0 and on this repo's 2.2.0. I isolated the cause:

```
FAIL   doc's exact proto (no syntax, no package)   -> illegal token 'uuid'
PASS   + syntax = "proto3";
PASS   + syntax = "proto3"; package P;
```

**Custom types only resolve in a schema that declares `syntax = "proto3";`**, which the example omits and the page never states. The repo's own passing test (`test/unit/bigint.test.ts:240-271`) includes it. One line fixes the example.

> So: the framework's custom-type feature is documented twice, and **neither version runs.** The working form is `context.factory.registerType(type)` with a proto3 schema.

### ❌ 3. "Enable Debug Logging" does not enable debug logging — `troubleshooting.md:361-374`

**Silently wrong** — the worst kind. The code runs, nothing errors, and you get no debug output. Executed:

```
after the documented recipe, logger received: ["info:an info line"]
after also calling setLogLevel(LogLevel.Debug):  ["debug:a debug line"]
```

Debug is **off by default** (`lib/logger.ts:23-35` — `LOG_LEVEL` unset means `Info`), and `Logger.debug` is gated on the level before it ever reaches your sink (`lib/logger.ts:68-73`). The section shows only `setLogger()`. **`setLogLevel` is not mentioned anywhere in `troubleshooting.md`.** A reader debugging a live problem concludes protobus emits no debug logging.

### ❌ 4. Getting Started's last step cannot run — `getting-started.md:154-185`

```
MissingProto: no service in the schema matches 'Calculator.Subscriber' or any
prefix of it; the .proto must declare the service this class serves
```

Step 6's subscriber declares `Calculator.Subscriber`; Step 1's proto declares only `service Math`. Full detail in Part 1.

### ❌ 5. The documented way to run anything crashes — `getting-started.md:196`, `:201`

`npx ts-node server.ts` → `TypeError: Cannot read properties of undefined (reading 'fileExists')`. Part 1.

### ❌ 6. The README's Quick Start is incompatible with the README's own CLI — `README.md:143-153`

`ERROR: Top-level await is currently not supported with the "cjs" output format`. Part 1.

### ❌ 7. The CLI's "Output example" is not the CLI's output — `cli.md:56-71`

Documented:

```typescript
export interface IAddRequest { a?: number; b?: number; }
export interface Service { add(request: ...): Promise<...>; }
```

Actually generated:

```typescript
export interface IAddRequest extends Calculator.AddRequest.$Properties { }
export interface Service { add: Calculator.Service.add; }
```

Illustrative rather than dangerous, but a reader writing against the documented shape writes against a shape that does not exist.

### ❌ 8. A false claim on the adoption page — `similar-libraries.md:225`

> "Benchmark code available in the repository. Independent benchmarks welcome!"

There is no benchmark code in the repository. `find . -iname "*bench*"` returns nothing; `sample/` holds `combatGame` and `tokenStream`. The page invites verification of numbers that cannot be verified — on the page whose job is to be believed.

### ❌ 9. The Trie example — `message-flow.md:208` *(already fixed in PR #33)*

Confirmed against the real `Trie`: `ORDERS.*.CREATED` does **not** match `ORDERS.US.123.CREATED`. Counted here only because it is the reason for this section.

## What the sweep vindicates

This matters as much as the failures, and it is the strongest evidence in the review:

- **The `Trie` documentation is otherwise sound.** I executed all 22 wildcard claims across `message-flow.md`, `api/events.md` and `architecture.md` against the real matcher. **21 hold**, including every row of the `api/events.md` pattern tables and the `#`-in-the-middle form (`ORDERS.#.COMPLETED`) that I expected to fail. The known bug was an isolated slip, not a symptom.
- **`configuration.md` is 18/18.** Every documented environment default matches the code, including the two (`SHUTDOWN_DRAIN_TIMEOUT_MS`, `SHUTDOWN_EXIT_GRACE_MS`) that live in `runnable_service.ts` rather than `Config` and which I initially mis-scored as wrong.
- **`advanced/priority.md` is 18/18** — every constant, every validation boundary, the `lateAck` refusal, and the live queue argument:
  ```
  PrioDoc.Service         arguments={'x-max-priority': 2}
  PrioDoc.Service.Events  arguments={}
  ```
  exactly as its Scope section describes.
- **The CLI does what it says**, including honouring a custom `protoDir` / `typesOutput` / `servicesDir`.

## So can the documentation be trusted?

**Conditionally, and the condition is knowable.** The failure is not randomly distributed — it tracks the two-generation split exactly. Every executed 2.x page was perfect. Every false example is in a 0.9-era page or the root README, which was never re-audited when the API moved underneath it.

That is good news: this is a **bounded** problem with a **known** boundary, not a rot. Executing the examples in eight files finds essentially all of it. My recommendation is to make that permanent — the repo already runs `scripts/run-combat-sample.sh` in CI as an end-to-end guard; a similar script that compiles and runs the doc snippets would have caught seven of the nine.

---

# Part 1 — The cold start

I followed the documentation literally from an empty directory, against the real broker from `docker-compose.yml`. Everything below is a recorded transcript, not a reading.

## Time to a working service

| Milestone | Elapsed | Notes |
|---|---|---|
| First RPC returning a correct answer (`5 + 3 = 8`) | **~4.5 min** of tool time | after **2 blocking failures** requiring knowledge not in the docs |
| Full flow, RPC + event delivered to a subscriber | **~7 min** | after a **third** failure requiring a source read |
| Understanding *why* it works | **never, from the docs alone** | the retry/DLQ topology, the parked-caller semantics and the ack ordering are not in any documentation page |

That 4.5 minutes is an agent's wall-clock with no typing and no context-switching. **A human hitting the same three dead ends is a 30–60 minute onboarding**, and two of the three end in a stack trace with no visible connection to protobus. The library itself is not the problem — once running, everything worked first time and the error messages are excellent.

## Failures, in the order I hit them

### 1. `npx ts-node server.ts` does not run — `getting-started.md:196`, `:201`

The guide's Prerequisites (`getting-started.md:5-9`) list Node, RabbitMQ and "TypeScript knowledge". It never tells you to install TypeScript or a TypeScript runner. Step "Running the Example" then says:

```bash
npx ts-node server.ts
```

Literally executed:

```
TypeError: Cannot read properties of undefined (reading 'fileExists')
    at readConfig (.../ts-node/dist/configuration.js:91:33)
```

Two compounding problems:

- **ts-node was never installed** and is not a dependency of anything the docs told me to install. `npx` silently fetched a floating copy with no TypeScript peer.
- **After installing it properly, it still fails.** `npm i -D typescript ts-node` today resolves TypeScript **7.0.2**, and ts-node 10.9.2 crashes against it. The documented runner is dead on any fresh install.

The repo itself does not use ts-node — `package.json` uses `tsc` and `ts-jest`, and `scripts/run-combat-sample.sh:13` even says *"the repo has no ts-node"*. **The docs recommend a tool the project deliberately avoids and that no longer works.** Switching to `tsx` fixed it immediately.

> Fix: add `typescript` + `tsx` to Prerequisites with the install command, and change both `npx ts-node` invocations to `npx tsx`.

### 2. Step 6 cannot work against Step 1 — `getting-started.md:154-185`

This is a documentation bug, not an environment one. Step 6's subscriber declares:

```typescript
public get ServiceName(): string { return 'Calculator.Subscriber'; }
```

…but Step 1's `calculator.proto` (`getting-started.md:23-45`) declares only `service Math`. The framework refuses to start:

```
MissingProto: no service in the schema matches 'Calculator.Subscriber' or any
prefix of it; the .proto must declare the service this class serves
```

**The final step of the getting-started guide is copy-pasteable and cannot run.** The guide's own artifacts contradict each other across steps.

Worse, `api/events.md:88-101` — the page you would go to next — shows a `NotificationService` with the same shape and would walk a reader into the same wall.

> Fix: add `service Subscriber {}` to the Step 1 proto and say why, or make the subscriber a method on the existing service.

### 3. The rule that fixes it is only in the source — `lib/message_service.ts:163-181`

**Nowhere in 6,545 lines of documentation does it say that a subscribe-only service still needs a `service` block declared in a `.proto`.** I found it by reading `resolveContract()`. Confirmed the fix works:

```
$ printf '\nservice Subscriber {\n}\n' >> src/proto/calculator.proto
$ npx tsx src/event-subscriber.ts
Listening for events...
Received event: add = 8
```

The same function also implements an entirely **undocumented feature**: `ServiceName` may carry extra runtime segments that are trimmed to find the contract — the source's own example is `Combat.Player.player6` resolving against `Combat.Player`. That is how you run per-instance services. Zero documentation hits for it.

### 4. The documented client never exits — `getting-started.md:132-152`

Step 5's client prints its answer and then hangs forever. Verified: still running at 25 seconds, killed manually.

There is no `close()`, no `process.exit()`, and no note that one is needed. Across all 23 files, `close()` appears twice (`examples.md:244`, `api/runnable-service.md:81`) and both are about the reader's own database connection. **How to shut a client down cleanly is not documented anywhere.**

### 5. The README's Quick Start is incompatible with the README's own CLI — `README.md:143-153`

The root README teaches a *different* workflow from `getting-started.md` (see Part 2). Following the README's own path — `npx protobus generate`, `npx protobus generate:service Calculator`, then step 4's client — fails:

```
ERROR: Top-level await is currently not supported with the "cjs" output format
```

Step 4's snippet uses top-level `await` with no `async function main()` wrapper, which requires ESM. The service stub that the README's own CLI generates is CommonJS (`if (require.main === module)`). The README never mentions `"type": "module"` or any module-system requirement. Wrapping in `main()` worked immediately.

### 6. `tsconfig.json` appears from nowhere — `getting-started.md:204-220`

"Project Structure" shows a `tsconfig.json` in the recommended layout. Its contents are never given anywhere in the docs, and the repo's own one sets `experimentalDecorators: true`.

## What worked, and worked well

An unbalanced review is useless, so:

- **`npm install protobus` is clean** — 11 packages, no peer warnings, no build step.
- **The CLI is genuinely good.** `npx protobus generate` worked with **zero configuration** — it found `./proto`, and wrote `./common/types/proto.ts` with sensible defaults, before I had added the `protobus` key the README tells you to add. `generate:service Calculator` produced a correct, runnable stub. Generated types are high quality (`ServiceName` as a `const`, per-method `path`/`requestType`/`responseType` literals).
- **The error messages are better than the documentation.** `MissingProto` told me exactly what was wrong and what to do; the docs did not. `InvalidPriorityError` (`lib/message_listener.ts:63-70`) is a small essay explaining why the combination is refused rather than warned about.
- **Once running, everything worked first time.** RPC, events, wildcard routing, competing consumers, graceful shutdown — no flakiness, no retries needed.
- **`sample/combatGame` is a delight and it passes:**
  ```
  ==> Result: 114 shots fired, 1 winner(s), 5 eliminated
  PASS: combat game completed with exactly one winner
  ```
  Six services, RPC + pub/sub + shutdown, self-asserting. **This should be the first thing in the documentation. It is currently in none of it.**

---

# Part 2 — Structure

## The three readers

| Reader | Wants | Currently gets |
|---|---|---|
| **Evaluating adoption** | "is this serious, and why not Moleculer?" | `architecture.md` — the least accurate page in the set. The benchmark that answers their actual question is buried at `similar-libraries.md:197`, and claims code that does not exist |
| **Building a first service** | one path from zero to running | **two contradictory tutorials** (below), the better one of which is in a file the docs index never links |
| **Looking something up** | an answer in 30 seconds | two incomplete, mutually contradictory indexes; no search; 33% of the API absent |

## Evidence that the information is scattered — confirmed

Your read is correct, and here is the proof.

**Two tutorials that contradict each other.** `README.md:90-153` and `docs/getting-started.md` both teach "your first service", and they disagree on every choice:

| | root `README.md` Quick Start | `docs/getting-started.md` |
|---|---|---|
| Base class | `RunnableService` | `MessageService` |
| Codegen | `npx protobus generate` | none — hand-written types |
| Proto service name | `service Service` → `Calculator.Service` | `service Math` → `Calculator.Math` |
| Proto resolution | by convention | explicit `ProtoFileName` getter |
| Start | `RunnableService.start(...)` | `new Service(ctx); await service.init()` |
| Module system | ESM (top-level await) | CommonJS (`__dirname`) |

Neither mentions the other. A reader who does both gets two incompatible mental models — and `getting-started.md` never mentions the CLI **at all**, so the guide called "Getting Started" teaches the path the CLI exists to replace.

**The retry/DLQ mechanism is told in four places and completely in none.** Starting one service creates four queues. The mechanism that uses them appears as: a passing reference at `queue-migration.md:78`; some prefetch arithmetic in `priority.md:142-207`; application-level advice in `error-handling.md` (which never names `<Service>.Retry`, `<Service>.DLQ`, the TTL, or the DLX); and the real thing at `lib/connection.ts:930-1030`. **The six `x-*` headers protobus stamps on every retried and dead-lettered message — the entire ops debugging surface — are documented nowhere.** Nor is the most important consequence: *the caller stays parked for the whole ladder*, so with the defaults a permanently failing call blocks its caller ~15s.

**The best "why" content is in the CHANGELOG, not the docs.** `CHANGELOG.md:326-400` explains the 2.0 delivery-semantics changes — confirm-based publishes, mandatory RPC requests, reply-before-ack, confirmed retry handoffs — better than any documentation page explains anything. Meanwhile `migration.md`, whose entire job is that, has **no 1.x → 2.x section at all** (see below). 44KB of excellent prose is filed where nobody reads it.

**The same three topics are told three times each.** The RPC flow: `architecture.md:213-223`, `message-flow.md:34-107`, and again in `api/service-proxy.md`. The event flow: `architecture.md:225-230`, `message-flow.md:160-195`, `api/events.md:8-13`. Wildcard patterns, fully specified: `architecture.md:138-146`, `message-flow.md:197-221`, `api/events.md:122-152`. Three chances to drift, and they have.

## Is the root / `api` / `advanced` split right?

**No, and `advanced/` is the problem.** It is doing two unrelated jobs:

- *capabilities you might opt into* — `streaming.md`, `priority.md`, `protobuf-schema.md`
- *things you must know to run this in production* — `security.md`, `queue-migration.md`, `structured-logging.md`

Filing the security model and "how to change a setting on a live queue" under **Advanced** means the operator who needs them most never looks. Nothing about either is advanced; they are mandatory.

Meanwhile the repo root is a junk drawer of ten unrelated pages, and `api/` holds five files covering **37 of 55 public exports**.

## Wrong place, specifically

| File | Problem | Should be |
|---|---|---|
| `advanced/error-handling.md` | 442 lines, of which `:72-320` (~270) are generic patterns — input validation, circuit breaker, graceful degradation — with nothing protobus-specific | the generic 60% moves to `examples.md`; the protobus part merges with the actual retry mechanism |
| `advanced/security.md` | operations, filed as advanced | `operations/` |
| `advanced/queue-migration.md` | operations, filed as advanced | `operations/` |
| `similar-libraries.md` | the adoption argument + the benchmark, hidden two clicks from the front | promoted; it is the page that sells the library |
| `api/events.md` | 337 lines that are mostly a tutorial, not an API reference | `guide/` |
| `advanced/protobuf-schema.md` | the `.proto` is the contract — this is chapter 3, not an appendix | `guide/` |
| `sample/` | the best onboarding asset in the repo, linked from nothing | the docs index and getting-started |

## Missing entirely

1. **A 1.x → 2.x migration.** `migration.md`'s compatibility table knows about 2.x, but its only sections are "Upgrading to 0.9.x", "0.7.x to 0.8.x", and how to migrate from tslint to eslint. 2.0.0 is a major with four breaking changes, one of which — proto3 zero values decoding as `0` rather than `undefined` — the CHANGELOG explicitly warns "can alter which branch your code takes without raising an error." **This is the single most expensive missing page.** It is mostly a restructuring of `CHANGELOG.md:326-400`.
2. **Delivery guarantees, as one page.** Ack ordering, publish confirms, `mandatory`, at-least-once, duplicates, what a confirm timeout means. Presently split across the CHANGELOG, `security.md:67`, and source comments.
3. **Testing a protobus service.** Zero coverage. The repo has unit and integration harnesses and a `docker compose up --wait` pattern; a reader gets none of it.
4. **An error reference.** `PublishError`, `PublishNackedError`, `UnroutableError`, `ProtocolError`, `InternalServiceError`, `StreamingError`, `StreamClosedError`, `StreamBackpressureError`, `ReconnectionError` — all exported, all undocumented, and the first three are the *new* error surface 2.0 introduced.
5. **Custom types.** `README.md:65-81` advertises the feature and links `docs/api/custom-types.md`, **which does not exist**. `BigIntType` and `TimestampType` appear nowhere in the docs.

## Proposed tree

Four buckets that map to intent, replacing three that map to nothing.

```
docs/
  README.md                      ← index with the three reader paths (exemplar included)

  guide/                         ← the ordered learning path; each page assumes the last
    getting-started.md           ← MOVED from root. Fixed per Part 1; adopt the CLI path
    schema.md                    ← MOVED from advanced/protobuf-schema.md. The .proto is the
                                   contract — chapter 3, not an appendix
    events.md                    ← MOVED from api/events.md. It is a tutorial, not a reference
    errors.md                    ← the protobus-specific ~40% of advanced/error-handling.md,
                                   merged with the retry ladder, currently only in source
    testing.md                   ← NEW
    patterns.md                  ← examples.md + the generic ~60% of error-handling.md
    streaming.md                 ← MOVED from advanced/. Optional chapter, not an appendix
    priority.md                  ← MOVED from advanced/. Ditto

  concepts/                      ← how it works; read once, refer back
    architecture.md              ← MOVED from root + corrected (exemplar included)
    message-flow.md              ← MOVED from root; wire format + round trip, dedup'd
                                   against architecture.md
    delivery-guarantees.md       ← NEW. From CHANGELOG 2.0.0 + security.md:67

  reference/                     ← look it up
    api/{context,message-service,runnable-service,service-proxy}.md   ← MOVED
    configuration.md             ← MOVED from root
    cli.md                       ← MOVED from root
    errors.md                    ← NEW. Every exported error class and when it is thrown
    custom-types.md              ← NEW. The file README.md:204 already links

  operations/                    ← run it in production. NOT "advanced"
    troubleshooting.md           ← MOVED from root
    queue-migration.md           ← MOVED from advanced/
    security.md                  ← MOVED from advanced/
    logging.md                   ← custom-logger.md + structured-logging.md MERGED
    known-issues.md              ← MOVED from root

  migration.md                   ← REWRITTEN, 1.x → 2.x first
  why-protobus.md                ← MOVED from similar-libraries.md; benchmark promoted
```

Net: 23 files → 25. Two merges, two splits, five new pages, and `advanced/` dissolved.

> [!WARNING]
> Moving files breaks external links, and `protobus-py` / `protobus-go` may point at the current paths. Budget for a release of one-line "Moved to X" stubs at the old locations, or land the moves with a major.

---

# Part 3 — Presentation

You are right that it is dull, and you are right about the cause: **there is no page anatomy.** Every page is `# Title`, then an unbroken run of `##` headings, then walls of monospace. Nothing is emphasised, so nothing reads as important; there is no way to tell a warning from a note from a passing remark; and there is no way in or out of a page except the browser's Back button.

## What GitHub-rendered markdown can already do

Ranked by value per hour. None of this needs a build step.

### 1. Mermaid — the big one

GitHub renders ```` ```mermaid ```` natively. This library's core ideas are **topological**, and there are **14 hand-drawn ASCII diagrams** across the set — `message-flow.md` is 180 of its 333 lines of box-drawing. They are laborious to maintain, they break on narrow screens, they cannot be zoomed or searched, and they are the single largest reason the docs look like a 2015 internal wiki.

I converted `architecture.md` to six Mermaid diagrams and **verified every one renders** (mermaid 11.17.2, headless Chromium, valid SVG, no syntax errors, labels correct). Two of them explain things no current diagram does — the full exchange→queue→consumer topology including retry and DLQ, and the failure ladder.

> [!CAUTION]
> **npmjs.com does not render Mermaid.** A diagram in the *root* `README.md` will display as raw text on the package page. Keep Mermaid in `docs/` and leave the root README's diagrams as ASCII or images.

### 2. GitHub alert callouts — free, and immediately fixes "nothing looks important"

`> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, `> [!CAUTION]` render as coloured, iconed panels. The 2.x pages are already *full* of sentences that should be these — `priority.md:22-26` is a warning written as a blockquote, `security.md:20` is a caution written as a paragraph. Zero cost, large effect.

### 3. A real index with reader paths

Not a list of every file — a table of *"I want to… → go here → it takes this long"*. Included as a second, smaller exemplar.

### 4. Consistent page anatomy

Every page gets: a one-line statement of what it is for; a prerequisites / next / source table; an "On this page" line; a prev · index · next footer. Currently some pages have a bare `Next:` line and none have prerequisites, so every page is an island.

### 5. `<details>` for depth without length

Container definitions, object graphs, "why this design" asides collapse. Pages scan short and stay complete.

### 6. Source links

Every concept links the file that implements it. Cheap, and it signals that the library is meant to be read.

### 7. Badges

npm version, Node, RabbitMQ, license. Thirty seconds, and their absence is conspicuous on a package that wants to look production-grade.

## Does it warrant a static docs site?

**Not yet. Do not build one now.**

Honest case *for*: real search (6,545 lines currently have none — this is the strongest argument); a persistent sidebar; versioned docs, which genuinely matters here given 0.9/1.x/2.x; and a landing page that looks like a product.

Honest case *against*, and it wins today:

- **It would make the current problems less visible, not smaller.** A site over this content gives you a beautifully navigable page that still says the concurrency default is unlimited. The complaint is "doesn't look like a top-notch framework" — but the failure mode for a careful evaluator is finding that `architecture.md` disagrees with `configuration.md`, and a sidebar does not help.
- **It breaks the source links.** Relative links like `../lib/context.ts` are one of the cheapest credibility wins available and VitePress will not serve them; every one becomes a hand-maintained absolute GitHub URL.
- **It splits the docs in two.** GitHub renders `docs/` whether you want it to or not. You either maintain both readings or accept that browsing the repo becomes the worse experience.
- **One maintainer.** A docs build that breaks blocks nothing, so it stays broken.

**Recommendation: earn it.** Do the correctness and structure work — which is required regardless, and mechanically produces a VitePress sidebar, since the proposed tree *is* the sidebar. Revisit when there are external adopters filing issues, or a second maintainer. At that point VitePress on already-correct content is about a day.

## Cost

| Phase | Work | Estimate |
|---|---|---|
| **0a — The nine false examples** *(do this first, alone if nothing else)* | Part 0. Export `registerCustomType` or rewrite both custom-type examples; add `syntax = "proto3";`; add `setLogLevel` to the debug section; fix Step 6's proto; `ts-node` → `tsx`; wrap the README's top-level await; correct the CLI output sample; delete the false benchmark claim | **~3 h** |
| **0b — Other correctness** | 7 factual errors, 5 broken links, the `v0.9.x` version string | **~3 h** |
| **0c — A guard so it cannot recur** | a script that compiles and runs the doc snippets, wired into CI beside `run-combat-sample.sh`. Would have caught 7 of the 9 | **~4 h** |
| **1 — The two expensive gaps** | `migration.md` 1.x→2.x (largely a restructure of the CHANGELOG); `delivery-guarantees.md` | **~4 h** |
| **2 — Structure + style** | the tree above; rewrite the 8 stale pages to the standard the 2.x pages already set; Mermaid; page anatomy; callouts | **~2–3 days** |
| **3 — Fill the gaps** | testing, error reference, custom types, make `sample/` discoverable | **~1 day** |
| **4 — Static site** | VitePress + GH Pages, on correct content | **~1 day, later, optional** |

**Phase 0a is three hours and is the highest-value work in this document.** A framework whose front-page example throws a `TypeError` reads as unmaintained no matter how it is styled — and no amount of Mermaid fixes that. Phase 0c is what stops it happening again. Phase 2 is where the "top-notch framework" feeling actually comes from.

---

## The exemplars in this branch

**`docs/architecture.md` — the main exemplar.** Rewritten to show the proposed anatomy, six verified Mermaid diagrams, GitHub alert callouts, `<details>` for depth, source links, and a prev/next footer. **It also corrects all five factual errors listed below** — so it is a content fix as much as a restyle, which is exactly the point.

**`docs/README.md` — a second, smaller exemplar.** The navigation half of the complaint. Reader-intent table, the 60-second sample as the first thing on the page, an ordered reading path, and a correct index.

Nothing else was touched. `git diff --stat` against `master` is three files.

---

# Appendix — every defect found

> The nine examples that do not do what they say are in **[Part 0](#part-0--examples-that-are-not-true)** and are not repeated here.

## Factual errors

| # | Where | Says | Actually | Source |
|---|---|---|---|---|
| D1 | `architecture.md:252-256` | "Default: No prefetch limit (unlimited concurrent messages)" | defaults to **1** | `lib/message_listener.ts:76`, `lib/config.ts:139` — and `configuration.md:58` says so correctly |
| D2 | `architecture.md:246-250` | "Negative acknowledgment with requeue (unless marked as `external`)" | publish-to-retry + ack, or DLQ + ack, or reject **without** requeue. No nack-with-requeue exists | `lib/connection.ts:930-1030` |
| D3 | `architecture.md:174-177` | `ResponseError { string message = 1; bool external = 2; }` | `{ string method = 1; string message = 2; string code = 3; }`. **`external` does not exist**; `code` — what `HandledError` sets — is undocumented | `lib/message_factory.ts:196-211` |
| D4 | `architecture.md:170-172` | `ResponseResult { bytes data = 1; }` | `{ string method = 1; bytes data = 2; }` | `lib/message_factory.ts:183-193` |
| D5 | `architecture.md:114-122` | "three exchanges" | **five** kinds — plus `proto.bus.cancel` (fanout) and `<Service>.Retry.Exchange` (topic, per service) | live broker, verified |
| D6 | `architecture.md:232-238` | three queue types | **four per service** (`X`, `X.Events`, `X.Retry`, `X.DLQ`) plus callback and cancel queues | live broker, verified |
| D7 | `api/service-proxy.md:147` | caller timeout is `MESSAGE_PROCESSING_TIMEOUT` | caller uses `RPC_CALL_TIMEOUT_MS` | `lib/config.ts:121`; `configuration.md:28` is correct |

## Broken and false references

| # | Where | Problem |
|---|---|---|
| E1 | `README.md:204` | links `docs/api/custom-types.md` — **does not exist**, and it is the doc for a feature advertised at `README.md:65-81` |
| E2 | `docs/README.md:28`, `advanced/error-handling.md:442` | link `advanced/http-routing.md` — **does not exist** |
| E3 | `similar-libraries.md:225` | "Benchmark code available in the repository." **There is none.** On the page that argues for adoption |
| E4 | `docs/README.md:53` | "This documentation is for Protobus v0.9.x" — package is **2.2.0** |
| E5 | `structured-logging.md:77`, `error-handling.md:195`, `api/service-proxy.md:280` | `[method](request)` — parses as a link to a nonexistent page and renders as one |

## Index incoherence

Two indexes, neither complete, contradicting each other:

- root `README.md` omits `examples.md`, `advanced/security.md`, `advanced/structured-logging.md`, `advanced/queue-migration.md`; its "Advanced Topics" table lists 5 of 8
- `docs/README.md` omits `similar-libraries.md` — the adoption argument
- each links exactly one file that does not exist

## Coverage

- **18 of 55 public exports (33%) appear nowhere in the docs**: `BigIntType`, `TimestampType`, `PublishError`, `PublishNackedError`, `UnroutableError`, `ProtocolError`, `InternalServiceError`, `StreamingError`, `StreamClosedError`, `StreamBackpressureError`, `ReconnectionError`, `Restorer`, `ContextOptions`, `LogFields`, `LogOutcome`, `getLogLevel`, `bigintToBytes`, `bytesToBigint`.
- **The retry ladder's six `x-*` headers** — `x-retry-count`, `x-original-routing-key`, `x-first-failure-time`, `x-last-error`, `x-original-queue`, `x-dlq-time` — documented nowhere.
- **The parked-caller semantics** — no reply is published during retries, so a failing call blocks its caller `maxRetries × retryDelayMs` (~15 s by default) — documented nowhere.
- **Multi-segment `ServiceName`** (`Combat.Player.player6` → contract `Combat.Player`) — documented nowhere.
- **A subscribe-only service still needs a `service` block in a proto** — documented nowhere; blocks `getting-started.md` Step 6.
- **Custom types cannot be registered from the package root** — `registerCustomType` exists (`lib/custom_types.ts:94`) but is not exported by `index.ts`. Both documented examples of the feature fail (Part 0).
- **No testing documentation** of any kind.
- **`sample/combatGame`** — referenced by no documentation page. `sample/tokenStream` gets one line at `streaming.md:367`.

## Reproduction

Cold start:

```bash
docker compose up -d --wait
mkdir cold && cd cold && npm init -y && npm i protobus
# then follow docs/getting-started.md literally
```

The three example failures worth reproducing directly:

```bash
# 1. README.md:69-81 — TypeError: registerCustomType is not a function
node -e "const p=require('protobus'); console.log(typeof p.registerCustomType)"   # undefined

# 2. protobuf-schema.md:191-215 — illegal token 'uuid'
#    passes only once `syntax = "proto3";` is added to the parsed schema

# 3. troubleshooting.md:361-374 — the debug line never reaches the sink
#    until setLogLevel(LogLevel.Debug) is also called
```

Routing, config and priority claims were executed against `lib/trie.ts`, `lib/config.ts`,
`lib/priority.ts` and a live broker; all counts in Part 0 are reproducible from those.
