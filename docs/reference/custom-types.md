# Custom Types

> Teaching protobuf a scalar it does not have — `bigint`, `timestamp`, or one of your own — and the three rules that make it actually work.

**Read this if** you want a domain type to appear in a `.proto` as though it were built in, or you are looking at `illegal token 'money'` and cannot see what is wrong with your schema.

| | |
|---|---|
| **Prerequisites** | [Schema Design](../guide/schema.md) — you have written a `.proto` |
| **Next** | [Context](./api/context.md) · [Configuration](./configuration.md) |
| **Source** | [`lib/custom_types.ts`](../../lib/custom_types.ts) · [`lib/message_factory.ts`](../../lib/message_factory.ts) · [`test/unit/custom_type_encoding.test.ts`](../../test/unit/custom_type_encoding.test.ts) · [`test/unit/bigint.test.ts`](../../test/unit/bigint.test.ts) |

**On this page** — [What a custom type is](#what-a-custom-type-is) · [The API](#the-api) · [`syntax = "proto3"` is mandatory](#syntax--proto3-is-mandatory) · [Worked example](#worked-example-money) · [When to register](#when-to-register) · [Registration is global](#registration-is-global) · [The built-ins](#the-built-ins) · [`ICustomType` reference](#icustomtype-reference)

---

## What a custom type is

Protobuf has no `decimal`, no `Date`, no 256-bit integer. The usual workaround is a wrapper message plus conversion code at both ends, repeated per field.

A custom type moves that conversion into the codec. You register a name, a wire representation and a pair of functions, and from then on the name is usable in a `.proto` exactly where a scalar would go:

<!-- doc-check: proto id=money-proto -->
```protobuf
syntax = "proto3";
package Billing;

message Invoice {
    string id    = 1;
    money  total = 2;
}

service Api {
    rpc issue (Invoice) returns (Invoice);
}
```

`money` is not a protobuf type. On the wire that field is a plain `string`; in your handler it is whatever your `decode` returns. Nothing else in the message changes, and a peer that has not registered `money` still reads the field as the underlying scalar.

Under the hood a registration writes protobufjs's `wrappers` table — the same mechanism protobufjs uses for `google.protobuf.Timestamp` — with a generated one-field message class carrying the wire value ([`lib/custom_types.ts:68`](../../lib/custom_types.ts)).

---

## The API

> [!IMPORTANT]
> The working API is **`context.factory.registerType(customType)`** — an instance method on `MessageFactory`, reached through `context.factory`.
>
> The module-level `registerCustomType()` in [`lib/custom_types.ts`](../../lib/custom_types.ts) is **not exported from the package root**. The package's custom-type exports are exactly five: `ICustomType`, `BigIntType`, `TimestampType`, `bigintToBytes`, `bytesToBigint` ([`index.ts:76`](../../index.ts)). Any example importing `registerCustomType` from `'protobus'` does not compile, and any example calling it with a `(name, definition)` pair describes a signature that has never existed — `registerCustomType` takes one argument, the whole `ICustomType`.

`registerType` returns the generated protobufjs `Message` class. You can ignore the return value; nothing in normal use needs it.

---

## `syntax = "proto3"` is mandatory

This is the rule that makes most first attempts fail, and it is not mentioned anywhere else in these docs.

> [!WARNING]
> A schema that uses a custom type **must** open with `syntax = "proto3";`. Without it protobufjs rejects the file with `illegal token '<yourtypename>'` — pointing at your type, which reads as "protobus never registered it" and sends you looking in the wrong place entirely.

The cause is not custom types at all. With no `syntax` statement protobufjs parses in **proto2** mode, where every field needs an explicit label. The parser reads the first token of the field as that label, finds `money` where it wanted `optional` / `required` / `repeated`, and stops. The identical error appears for `string s = 1;` in a file with no `syntax` line — custom types are just where people meet it, because a custom-type schema is usually the first one they hand to `factory.parse()` as a string rather than loading a generated file.

<!-- doc-check: ignore why="deliberately broken: protobufjs rejects it, which is the point of the example" -->
```protobuf
package Billing;                         // no syntax statement

message Invoice {
    money total = 1;                     // Error: illegal token 'money' (line 3)
}
```

Two ways to fix it, and only the first is worth using:

- add `syntax = "proto3";` as the first line;
- or write proto2 properly — `optional money total = 1;` parses. Do not do this; the rest of protobus assumes proto3 field semantics.

---

## Worked example: `Money`

A currency amount, carried as a `"USD:1999"` string on the wire and as an object in application code. The schema is the [`money-proto`](#what-a-custom-type-is) block above.

<!-- doc-check: compile id=money-type -->
```typescript
import { Context, ICustomType } from 'protobus';

export interface Money { currency: string; cents: number }

export const MoneyType: ICustomType<Money> = {
    name: 'money',            // the token that appears in the .proto
    wireType: 'string',       // how it is actually encoded
    tsType: 'Money',          // what `protobus generate` writes into the .d.ts
    encode: (value: Money) => `${value.currency}:${value.cents}`,
    decode: (data: string) => {
        const [currency, cents] = String(data).split(':');
        return { currency, cents: Number(cents) };
    },
};

export async function start(): Promise<Context> {
    const context = new Context();
    context.factory.registerType(MoneyType);          // BEFORE init, see below
    await context.init('amqp://guest:guest@localhost:5672/', ['./proto']);
    return context;
}
```

A handler then receives and returns `Money` objects with no conversion code:

<!-- doc-check: compile id=money-handler needs=money-type -->
```typescript
import { RunnableService } from 'protobus';

export abstract class BillingApi extends RunnableService {
    get ServiceName() { return 'Billing.Api'; }

    async issue(request: { id?: string; total?: Money }) {
        const total = request.total ?? { currency: 'USD', cents: 0 };
        return { id: request.id, total: { ...total, cents: total.cents + 50 } };
    }
}
```

`tsType` is a **string that is emitted verbatim** into generated TypeScript — `total?: (Money | null)`. It is not checked against anything, and the generator does not import `Money` for you. Point it at a type your generated code can see, or you get a `.d.ts` that does not compile.

> [!TIP]
> `encode` is called with whatever the application passed, which will not always be your type: a JSON body, a value round-tripped through a queue, a test fixture. `BigIntType.encode` accepts `bigint`, a decimal string, a hex string and a number for exactly this reason. Be similarly tolerant, and fail loudly on input you cannot represent rather than coercing it.

---

## When to register

Registration must happen **before the schema that uses the type is parsed**. That is the whole rule; `init()` is not the boundary people assume.

`MessageFactory.init()` builds a fresh root, adds the built-ins, then re-adds everything registered so far, and only then calls `loadSync()` on the proto files ([`lib/message_factory.ts:395`](../../lib/message_factory.ts)). `loadSync` resolves eagerly, so a schema on disk that names an unregistered type fails right there.

| Order | Result |
|---|---|
| `registerType()`, then `factory.init([])`, then `factory.parse(schema)` | works |
| `factory.init([])`, then `registerType()`, then `factory.parse(schema)` | works |
| `factory.init([protoDir])` where a file in `protoDir` uses the type, then `registerType()` | **fails**: `no such Type or Enum 'money' in Type .Fin.Amount` |

Both working orders are pinned by tests — [`test/unit/bigint.test.ts:241`](../../test/unit/bigint.test.ts) registers before `init`, and the case at line 282 registers after it.

Since `Context.init()` calls `messageFactory.init(protoLocations)` as its first statement ([`lib/context.ts:57`](../../lib/context.ts)), the practical rule for an application is simple:

> [!IMPORTANT]
> Register on `context.factory` **before** `await context.init(...)`. `context.factory` exists from the moment the `Context` is constructed, so there is no reason to leave it later.

A service that supplies its own schema through `ProtoFileName` rather than a proto directory has more room — that schema is parsed during `service.init()` — but the rule above is correct in both cases and costs nothing.

---

## Registration is global

> [!CAUTION]
> **A custom type is process-wide, not per factory.** `registerType` writes protobufjs's module-level `wrappers` table, which is shared with every other consumer of protobufjs in the process, plus a module-level registry. Names are therefore global: the last registration of a name wins, and every `MessageFactory` sees it. Two factories cannot hold different definitions of `money`. Namespace your names — `acme_money`, not `money` — if the process hosts more than one schema, or if you publish a library that registers types.
>
> The source comment at [`lib/custom_types.ts:79`](../../lib/custom_types.ts) explains why it has to be this way: protobufjs resolves a wrapper by fully-qualified type name at encode and decode time, with no per-root table to put it in.

Only the addition to `root` is per instance — which produces one sharp edge:

> [!WARNING]
> **Registering the same name twice on one factory throws.** `registerType` ends in `root.add(...)`, and protobufjs rejects a duplicate: `duplicate name 'money' in Root`. This also means `factory.registerType(BigIntType)` throws — `bigint` and `timestamp` are already in every root — so re-registering a built-in "to be safe" breaks startup rather than being the no-op it looks like.
>
> Registering the same type on a *second* factory is fine; each has its own root.

---

## The built-ins

`bigint` and `timestamp` are registered at module load, before any factory exists ([`lib/custom_types.ts:266`](../../lib/custom_types.ts)). They are available in every schema with no setup. Do not register them again — see the warning above.

### `bigint`

| | |
|---|---|
| Wire type | `bytes` — **32 bytes, fixed width, big-endian, unsigned** (uint256-compatible) |
| Decodes to | native JavaScript `bigint` |
| Accepts | `bigint`, decimal string, `0x` hex string, `number` |
| Range | `0` … `2^256 - 1` (`BIGINT_MAX`) |

Out-of-range values raise a `RangeError` rather than being coerced. `-5n` is **not** encoded as `5n` and `2^256 + 7` is **not** truncated to `7`; both throw, and both were real defects before the check existed ([`test/unit/custom_type_encoding.test.ts:126`](../../test/unit/custom_type_encoding.test.ts)). For money and on-chain amounts, failing loudly is the only safe behaviour.

Decoding is bounded too: a wire value longer than 32 bytes throws instead of being decoded. The accumulator shifts once per byte, so its cost is quadratic in the input — a 1 MiB malformed value would occupy the event loop for over a minute before any handler ran.

`bigintToBytes(value)` and `bytesToBigint(bytes)` are exported for use outside a message. They are thin wrappers over `BigIntType.encode` / `.decode` ([`lib/custom_types.ts:270`](../../lib/custom_types.ts)) and carry the same range checks:

<!-- doc-check: compile id=bigint-utils -->
```typescript
import { bigintToBytes, bytesToBigint } from 'protobus';

const wire = bigintToBytes('0xdeadbeef');       // Uint8Array(32), big-endian
console.log(wire.length);                        // 32
console.log(bytesToBigint(wire));                // 3735928559n
console.log(bytesToBigint(new Uint8Array(0)));   // 0n — empty decodes to zero
```

### `timestamp`

| | |
|---|---|
| Wire type | `int64` — milliseconds since the Unix epoch |
| Decodes to | `Date` |
| Accepts | `Date`, `number` (ms), ISO string |

Decoding handles protobufjs's `Long` representation `{ low, high }` as well as a plain number. The high word is treated as **signed**, which is what keeps pre-1970 instants working: coercing it with `>>> 0` turns every negative timestamp into a value far enough out of range that the `Date` is `Invalid` rather than merely wrong.

> [!NOTE]
> `timestamp` is protobus's own type, unrelated to `google.protobuf.Timestamp`. On the wire it is a single `int64`, not a `{seconds, nanos}` message, so a non-protobus consumer reading the field sees milliseconds. That is deliberate — it is cheaper and it survives a peer that knows nothing about custom types — but it is not interchangeable with the well-known type.

---

## `ICustomType` reference

**Five required members.** All five, including `tsType`; there are no optional fields on this interface ([`lib/custom_types.ts:21`](../../lib/custom_types.ts)).

| Member | Type | Meaning |
|---|---|---|
| `name` | `string` | the token used in `.proto` files. Lowercase, so it reads like a built-in scalar |
| `wireType` | see below | how the value is actually encoded |
| `encode` | `(value: any) => Buffer \| Uint8Array \| string \| number \| bigint` | application value → wire value |
| `decode` | `(data: any) => T` | wire value → application value |
| `tsType` | `string` | the TypeScript type name emitted by the generator, verbatim |

**The allowed `wireType` values, exactly:**

```
'bytes' | 'int64' | 'uint64' | 'string' | 'int32' | 'uint32' | 'double'
```

`bytes` is the most flexible and the one both built-ins-by-default reach for; `string` is the easiest to debug, because a malformed value is readable in the RabbitMQ management UI.

> [!TIP]
> Write `decode` defensively about the container it receives. For `bytes` protobufjs may hand you a `Buffer` or a `Uint8Array` depending on the path; `Buffer.from(data)` normalises both. For `int64` it may hand you a number or a `Long`.

Custom types nest. A `bigint` three messages deep round-trips correctly, including inside self-referential messages — there is a dedicated regression suite for it, because an earlier version reported such messages as "no custom types", skipped preprocessing, and sent the nested value out as zero with the decision cached for the life of the process ([`test/unit/custom_type_encoding.test.ts:59`](../../test/unit/custom_type_encoding.test.ts)).

---

<div align="center">

**[← Errors](./errors.md)** · **[Docs index](../README.md)** · **[Context →](./api/context.md)**

</div>
