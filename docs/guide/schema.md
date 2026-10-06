# Schema Design

> The `.proto` file is the contract. Everything else (the queue name, the routing key, the generated types) follows from it.

**Read this if** you are about to write or change a schema, or you want to know which changes are safe to deploy.

| | |
|---|---|
| **Prerequisites** | [Getting Started](./getting-started.md) |
| **Next** | [CLI](../reference/cli.md) (generating types from it) · [Custom Types](../reference/custom-types.md) |
| **Source** | [`lib/message_factory.ts`](../../lib/message_factory.ts) · [`lib/custom_types.ts`](../../lib/custom_types.ts) |

## Basic Structure

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
syntax = "proto3";
package MyPackage;

// Messages
message MyRequest { ... }
message MyResponse { ... }

// Events
message MyEvent { ... }

// Service
service MyService {
    rpc myMethod(MyPackage.MyRequest) returns(MyPackage.MyResponse);
}
```

## Naming Conventions

### Package Names
- Use PascalCase: `OrderManagement`, `UserAuth`
- Keep concise but descriptive
- Represents a bounded context or domain

### Service Names
- Use PascalCase: `OrderService`, `PaymentProcessor`
- Full name is `Package.ServiceName`

### Message Names
- Use PascalCase: `CreateOrderRequest`, `OrderCreatedEvent`
- Suffix requests with `Request`
- Suffix responses with `Response`
- Suffix events with `Event`

### Field Names
- Use snake_case: `order_id`, `created_at`
- Be descriptive: `user_email` not `email`

## Message Design

### Request Messages

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message CreateOrderRequest {
    // Required fields first
    string user_id = 1;
    repeated OrderItem items = 2;

    // Optional fields
    string coupon_code = 3;
    ShippingAddress shipping_address = 4;

    // Metadata
    string idempotency_key = 10;
}
```

### Response Messages

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message CreateOrderResponse {
    // Primary result
    string order_id = 1;

    // Additional info
    OrderStatus status = 2;
    int64 estimated_delivery = 3;

    // Computed values
    Money total_amount = 4;
}
```

### Event Messages

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message OrderCreatedEvent {
    // Event identification
    string event_id = 1;
    int64 timestamp = 2;

    // Entity reference
    string order_id = 3;

    // Context
    string user_id = 4;
    string source = 5;  // What triggered this

    // Relevant data (not full entity)
    Money total_amount = 6;
    int32 item_count = 7;
}
```

## Field Types

### Scalar Types

| Proto Type | TypeScript | Use For |
|------------|------------|---------|
| `string` | `string` | Text, IDs, UUIDs |
| `int32` | `number` | Small integers |
| `int64` | `string` | Timestamps, large integers |
| `bool` | `boolean` | Flags |
| `bytes` | `Buffer` | Binary data |
| `double` | `number` | Floating point |
| `bigint` | `bigint` | Large integers (uint256, etc.) |

#### 64-bit integers decode to strings

`int64`, `uint64`, `sint64`, `fixed64` and `sfixed64` hold values wider than the
integers a JavaScript number represents exactly, so decoding them into one would
silently corrupt anything past `Number.MAX_SAFE_INTEGER`. They decode to a
decimal string instead, which is exact across the whole range. Protobuf's own
canonical JSON mapping reaches for a string here for the same reason.

This is a JavaScript constraint, not a wire change. The bytes on the wire are
the same, and a peer decodes into whatever its language holds natively:
`protobus-py` gives you a Python `int`, `protobus-go` an `int64`.

Encoding stays permissive: pass a number or a string.

<!-- doc-check: compile -->
```typescript
// A field declared `int64 recorded_at = 1;`, once decoded.
declare const reading: { recorded_at: string };

const when = new Date(Number(reading.recorded_at));
const exact = BigInt(reading.recorded_at);   // safe past 2^53
```

For values that genuinely exceed 64 bits, use protobus's own `bigint` type
below instead.

### Built-in Custom Types

Protobus provides built-in custom types that extend the standard protobuf scalar types:

| Type | TypeScript | Description |
|------|------------|-------------|
| `bigint` | `bigint` | Large integers (uint256 compatible, 32 bytes) |
| `timestamp` | `Date` | Timestamps (milliseconds, stored as int64) |

#### BigInt Type (Web3/Crypto)

The `bigint` type handles large integers commonly used in Web3 applications:

- Serializes to 32 bytes (big-endian, uint256 compatible)
- Deserializes to native JavaScript `bigint`
- Accepts `bigint`, `string` (decimal or hex), or `number` as input

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message TokenTransfer {
    string from = 1;
    string to = 2;
    bigint amount = 3;      // Native bigint support
    bigint gas_price = 4;
}
```

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
// Using native bigint
await tokenService.transfer({
    amount: 1000000000000000000n,  // 1 ETH in wei
});

// Using hex or decimal strings
await tokenService.transfer({
    amount: '0xde0b6b3a7640000',  // hex
});

// Response always returns native bigint
const balance = await tokenService.getBalance({});
console.log(typeof balance.value);  // 'bigint'
```

#### Timestamp Type

The `timestamp` type provides convenient Date handling:

- Serializes to int64 (milliseconds since epoch)
- Deserializes to JavaScript `Date` object
- Accepts `Date`, ISO string, or milliseconds number as input

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message Event {
    string name = 1;
    timestamp created_at = 2;
    timestamp updated_at = 3;
}
```

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
// Using Date objects
await eventService.create({
    name: 'signup',
    created_at: new Date(),
});

// Using ISO strings
await eventService.create({
    name: 'signup',
    created_at: '2024-01-15T10:30:00.000Z',
});

// Response returns Date objects
const event = await eventService.get({});
console.log(event.created_at instanceof Date);  // true
```

### Custom Type Registration

You can define your own custom types by implementing the `ICustomType` interface:

<!-- doc-check: compile -->
```typescript
import { Context, ICustomType } from 'protobus';

const uuidType: ICustomType<string> = {
    name: 'uuid',           // how it is written in a .proto
    wireType: 'bytes',      // how it travels
    tsType: 'string',       // what generated types call it
    encode: (value: string) => Buffer.from(value.replace(/-/g, ''), 'hex'),
    decode: (data: Buffer) => {
        const hex = Buffer.from(data).toString('hex');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
};

async function main() {
    const context = new Context();

    // Register BEFORE init(): init() parses your .proto files, and a schema
    // using `uuid` cannot be parsed until the type exists.
    context.factory.registerType(uuidType);

    await context.init('amqp://localhost', ['./proto']);
}

main().catch((error) => { console.error(error); process.exit(1); });
```

The schema that uses it **must declare `syntax = "proto3";`**:

<!-- doc-check: ignore why="uses a custom type, so it only parses in a process that has registered uuid first" -->
```protobuf
syntax = "proto3";
package Entities;

message Entity {
    uuid id = 1;
    string name = 2;
}
```

> [!WARNING]
> Without the syntax line, protobufjs parses the file as proto2 (where every
> field needs an `optional` / `required` / `repeated` label) and reports the
> custom type as `illegal token 'uuid'`. Earlier versions of this page and of the
> root README both omitted it, and neither example ran. The rule is pinned by
> [`test/unit/documented_behaviour.test.ts`](../../test/unit/documented_behaviour.test.ts).

> [!CAUTION]
> **Custom type names are process-wide.** `registerType()` adds the type to
> > that factory's root, but the codec itself goes into protobufjs's module-level
> wrapper table, which is shared by everything in the process. Two factories
> cannot hold different definitions of the same name, and a name registered
> through one is visible to all of them. Registration is also **not idempotent**:
> registering the same name twice on one factory throws `duplicate name`, and the
> built-in `bigint` and `timestamp` are already registered. Namespace your names
> if a process hosts more than one schema.
>
> Full account: [Custom Types](../reference/custom-types.md).

Available wire types: `bytes`, `int64`, `uint64`, `string`, `int32`, `uint32`, `double`

### Timestamps

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
// Option 1: Unix timestamp (recommended)
int64 created_at = 1;  // milliseconds since epoch

// Option 2: ISO string
string created_at = 1;  // "2024-01-15T10:30:00Z"
```

### Money

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message Money {
    int64 amount = 1;      // In smallest unit (cents)
    string currency = 2;   // ISO 4217: "USD", "EUR"
}

// Usage
message Order {
    Money total = 1;
    Money tax = 2;
}
```

### Enums

<!-- doc-check: proto -->
```protobuf
enum OrderStatus {
    ORDER_STATUS_UNKNOWN = 0;  // Always have unknown/default
    ORDER_STATUS_PENDING = 1;
    ORDER_STATUS_PROCESSING = 2;
    ORDER_STATUS_SHIPPED = 3;
    ORDER_STATUS_DELIVERED = 4;
    ORDER_STATUS_CANCELLED = 5;
}
```

In TypeScript an enum decodes to its value *name* (`'ORDER_STATUS_SHIPPED'`).
When sending, give either the name or the number: both encode to the same
value, so a decoded message can be passed on unchanged.

### Field Presence: Zero vs. Unset

A plain proto3 scalar has no presence: a field equal to its default (`0`, `""`, `false`) is not written to the wire, and decoding supplies the default back. protobus decodes with defaults on, so every field arrives populated and a caller cannot tell "set to zero" from "not set".

When that difference matters (a partial update that must leave untouched fields alone, a count where `0` is a real answer distinct from "unknown"), declare the field `optional`:

<!-- doc-check: proto -->
```protobuf
syntax = "proto3";

message UpdateUser {
    string id = 1;
    optional string name = 2;   // absent: leave the name as it is
    optional int32 age = 3;     // 0 is a real age, distinct from "not supplied"
}
```

An `optional` field that was not set is absent from the decoded object, and one set to zero arrives as zero. It costs nothing on the wire beyond the field itself, works in every protobus port, and needs no migration: adding `optional` to an existing field is wire-compatible. Wrapper types such as `google.protobuf.Int32Value` do the same job less directly.

#### Protobuf editions

Editions (`edition = "2023"`) are **not supported in 2.x**. What they would add here is presence by default, and `optional` already provides presence per field, so adopting them now would be churn for ergonomics. They are planned for **3.0**, together with replacing the synthetic `bigint` and `timestamp` types with a custom field option such as `bytes balance = 1 [(protobus.type) = "bigint"];`, which would keep schemas valid for every other protobuf implementation.

What each port needs for that:

| Port | Editions | Custom field options |
|---|---|---|
| TypeScript | protobufjs 8.7.2 honours `features.field_presence` at file and field level | protobufjs 8.7.2 surfaces them on the field (`field.options`) |
| Go | protobuf-go 1.36 and protocompile 0.14 support edition 2023 | supported by protocompile and protobuf-go descriptors |
| Python | protobus-py's own `.proto` parser rejects `edition` | the same parser rejects `extend`, which declaring an option needs |

So the Python parser, and the minimum `protobuf` runtime it pins, set the pace for 3.0. Background and measurements: [#7](https://github.com/ArielLaub/protobus/issues/7).

### Repeated Fields (Arrays)

<!-- doc-check: proto -->
```protobuf
message Order {
    repeated OrderItem items = 1;
    repeated string tags = 2;
}
```

### Nested Messages

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message Order {
    message Item {
        string product_id = 1;
        int32 quantity = 2;
        Money price = 3;
    }

    repeated Item items = 1;
}
```

## Service Design

### One Operation Per Method

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
// Good: Single responsibility
service OrderService {
    rpc CreateOrder(CreateOrderRequest) returns(CreateOrderResponse);
    rpc GetOrder(GetOrderRequest) returns(GetOrderResponse);
    rpc UpdateOrder(UpdateOrderRequest) returns(UpdateOrderResponse);
    rpc CancelOrder(CancelOrderRequest) returns(CancelOrderResponse);
}

// Avoid: Multiple operations in one method
service OrderService {
    rpc ManageOrder(ManageOrderRequest) returns(ManageOrderResponse);
    // Where ManageOrderRequest has operation_type enum
}
```

### Request/Response Per Method

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
// Good: Dedicated types
rpc CreateOrder(CreateOrderRequest) returns(CreateOrderResponse);
rpc GetOrder(GetOrderRequest) returns(GetOrderResponse);

// Avoid: Reusing types
rpc CreateOrder(OrderRequest) returns(OrderResponse);
rpc UpdateOrder(OrderRequest) returns(OrderResponse);
```

## Evolving Schemas

### Adding Fields

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
// v1
message Order {
    string order_id = 1;
    string user_id = 2;
}

// v2 - Safe to add new fields
message Order {
    string order_id = 1;
    string user_id = 2;
    string notes = 3;        // New field - backwards compatible
    Money discount = 4;      // New field - backwards compatible
}
```

### Field Number Rules

- Never reuse field numbers
- Reserved removed fields

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```protobuf
message Order {
    reserved 3, 4;              // Removed fields
    reserved "old_field";       // Removed field names

    string order_id = 1;
    string user_id = 2;
    // field 3 was 'status' (removed)
    // field 4 was 'priority' (removed)
    string notes = 5;
}
```

### Breaking Changes (Avoid)

- Changing field types
- Changing field numbers
- Removing required fields
- Renaming messages used in services

## Complete Example

<!-- doc-check: proto -->
```protobuf
syntax = "proto3";
package Orders;

import "common/money.proto";

// Enums
enum OrderStatus {
    ORDER_STATUS_UNKNOWN = 0;
    ORDER_STATUS_PENDING = 1;
    ORDER_STATUS_CONFIRMED = 2;
    ORDER_STATUS_SHIPPED = 3;
    ORDER_STATUS_DELIVERED = 4;
    ORDER_STATUS_CANCELLED = 5;
}

// Common messages
message Address {
    string street = 1;
    string city = 2;
    string state = 3;
    string postal_code = 4;
    string country = 5;
}

message OrderItem {
    string product_id = 1;
    string product_name = 2;
    int32 quantity = 3;
    common.Money unit_price = 4;
}

// Request/Response messages
message CreateOrderRequest {
    string user_id = 1;
    repeated OrderItem items = 2;
    Address shipping_address = 3;
    string coupon_code = 4;
    string idempotency_key = 10;
}

message CreateOrderResponse {
    string order_id = 1;
    OrderStatus status = 2;
    common.Money total = 3;
}

message GetOrderRequest {
    string order_id = 1;
}

message GetOrderResponse {
    string order_id = 1;
    string user_id = 2;
    repeated OrderItem items = 3;
    Address shipping_address = 4;
    OrderStatus status = 5;
    common.Money subtotal = 6;
    common.Money tax = 7;
    common.Money total = 8;
    int64 created_at = 9;
    int64 updated_at = 10;
}

message CancelOrderRequest {
    string order_id = 1;
    string reason = 2;
}

message CancelOrderResponse {
    bool success = 1;
    string message = 2;
}

// Event messages
message OrderCreatedEvent {
    string event_id = 1;
    int64 timestamp = 2;
    string order_id = 3;
    string user_id = 4;
    common.Money total = 5;
    int32 item_count = 6;
}

message OrderShippedEvent {
    string event_id = 1;
    int64 timestamp = 2;
    string order_id = 3;
    string tracking_number = 4;
    string carrier = 5;
}

message OrderCancelledEvent {
    string event_id = 1;
    int64 timestamp = 2;
    string order_id = 3;
    string reason = 4;
    string cancelled_by = 5;
}

// Service definition
service OrderService {
    rpc CreateOrder(Orders.CreateOrderRequest) returns(Orders.CreateOrderResponse);
    rpc GetOrder(Orders.GetOrderRequest) returns(Orders.GetOrderResponse);
    rpc CancelOrder(Orders.CancelOrderRequest) returns(Orders.CancelOrderResponse);
}
```

---

<div align="center">

**[← Getting Started](./getting-started.md)** · **[Docs index](../README.md)** · **[Events →](./events.md)**

</div>
