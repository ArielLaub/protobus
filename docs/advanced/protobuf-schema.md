# Protobuf Schema Design

Best practices for designing Protocol Buffer schemas for Protobus services.

## Basic Structure

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
| `int64` | `number` | Timestamps, large integers |
| `bool` | `boolean` | Flags |
| `bytes` | `Buffer` | Binary data |
| `double` | `number` | Floating point |
| `bigint` | `bigint` | Large integers (uint256, etc.) |

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

```protobuf
message TokenTransfer {
    string from = 1;
    string to = 2;
    bigint amount = 3;      // Native bigint support
    bigint gas_price = 4;
}
```

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

```protobuf
message Event {
    string name = 1;
    timestamp created_at = 2;
    timestamp updated_at = 3;
}
```

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

```typescript
import { ICustomType } from 'protobus';

const uuidType: ICustomType<string> = {
    name: 'uuid',           // Type name in .proto files
    wireType: 'bytes',      // Underlying protobuf type
    tsType: 'string',       // TypeScript type for exports
    encode: (value: string) => Buffer.from(value.replace(/-/g, ''), 'hex'),
    decode: (data: Buffer) => {
        const hex = Buffer.from(data).toString('hex');
        return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    }
};

// Register before or after init()
messageFactory.registerType(uuidType);
messageFactory.init([]);

// Now use in .proto files
messageFactory.parse(`
    message Entity {
        uuid id = 1;
        string name = 2;
    }
`);
```

Available wire types: `bytes`, `int64`, `uint64`, `string`, `int32`, `uint32`, `double`

### Timestamps

```protobuf
// Option 1: Unix timestamp (recommended)
int64 created_at = 1;  // milliseconds since epoch

// Option 2: ISO string
string created_at = 1;  // "2024-01-15T10:30:00Z"
```

### Money

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

### Repeated Fields (Arrays)

```protobuf
message Order {
    repeated OrderItem items = 1;
    repeated string tags = 2;
}
```

### Nested Messages

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

Next: [Error Handling](./error-handling.md) | [Events](../api/events.md)
