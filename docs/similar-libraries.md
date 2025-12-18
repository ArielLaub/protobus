# Similar Libraries

## The Gap in Node.js Microservices

The Node.js ecosystem has no shortage of microservices frameworks. Yet most share a common philosophy: **transport agnosticism**. They abstract away the message broker to support pluggable transports—RabbitMQ today, Redis tomorrow, Kafka next week.

This flexibility comes at a cost. To support every broker, these frameworks reduce them all to a lowest common denominator: a dumb pipe that moves bytes. The sophisticated features that make each broker powerful—RabbitMQ's topic exchanges, Kafka's partitioning, NATS's simplicity—get ignored or reimplemented (poorly) at the application layer.

**ProtoBus takes a different path.**

We made a deliberate choice: build exclusively for RabbitMQ and leverage everything it offers. No abstraction layers. No "works everywhere, optimized nowhere." Just direct access to battle-tested broker features that have powered mission-critical systems for over a decade.

### Why This Matters

When a transport-agnostic framework does "load balancing," it tracks service instances in memory and picks one. If that instance dies between selection and delivery, your message is lost.

When ProtoBus does load balancing, messages sit in a RabbitMQ queue. Consumers pull work. If a consumer crashes before acknowledging, the message automatically requeues for another consumer. The broker handles it—because that's what brokers are designed to do.

This isn't a minor implementation detail. It's the difference between "usually works" and "guaranteed delivery."

### Why RabbitMQ?

RabbitMQ is boring technology—and that's a compliment. It's been battle-tested since 2007, powers systems at scale across every industry, and isn't going anywhere. In our experience, it's remarkably hard to find a project that RabbitMQ can't serve well.

By building exclusively for RabbitMQ, ProtoBus can leverage:

- **Topic exchanges** with powerful wildcard routing (`orders.*.created`, `orders.#`)
- **Competing consumers** for natural load distribution
- **Message acknowledgments** for guaranteed processing
- **Dead-letter exchanges** for handling failures gracefully
- **Durable queues** that survive broker restarts
- **Publisher confirms** for reliable publishing
- **Priority queues** when some messages matter more
- **TTL and expiration** for time-sensitive workloads

Transport-agnostic frameworks can't use most of these—they're RabbitMQ-specific. ProtoBus uses all of them.

---

## Framework Comparison

### Overview

| Aspect | ProtoBus | Moleculer | NestJS | Seneca |
|--------|----------|-----------|--------|--------|
| **Philosophy** | RabbitMQ-native | Transport-agnostic | Full framework | Pattern-based |
| **Transport** | RabbitMQ only | 10+ transporters | 7+ transporters | Pluggable |
| **Serialization** | Protocol Buffers | JSON (default) | JSON (default) | JSON |
| **Schema** | Required `.proto` | Optional | Optional (DTOs) | None |
| **Routing** | Broker-native | App-level | App-level | Pattern matching |
| **Load balancing** | Broker-level | App-level | App-level | App-level |
| **Message delivery** | Guaranteed | Best effort | Best effort | Best effort |
| **Learning curve** | Low | Medium | High | Low |
| **Dependencies** | 3 | 15+ | 50+ | 10+ |

---

### Moleculer

[Moleculer](https://moleculer.services/) is one of the most popular Node.js microservices frameworks, known for its extensive feature set and transport flexibility.

**How it works:**
Moleculer implements its own service registry, load balancer, and routing layer. The transporter (RabbitMQ, NATS, Redis, etc.) is just a message pipe—Moleculer handles everything else in application code.

**Strengths:**
- Extensive built-in features (caching, API gateway, tracing, metrics)
- Many transport options
- Active community and ecosystem
- Good documentation

**Trade-offs vs ProtoBus:**

| Aspect | Moleculer | ProtoBus |
|--------|-----------|----------|
| Routing | App-level service registry | Native RabbitMQ topic exchanges |
| Load balancing | Tracks instances, picks one | Competing consumers on queue |
| On consumer crash | Message may be lost | Auto-requeue, another consumer picks up |
| Serialization | JSON by default (larger, slower) | Protobuf binary (3-10x smaller) |
| Schema | Runtime validation (optional) | Compile-time `.proto` contracts |
| Persistence | Depends on transporter config | Native durable queues |

**When to choose Moleculer:**
- You need to switch brokers without code changes
- You want batteries-included (built-in API gateway, caching, etc.)
- You're building a monolith that might become microservices later

---

### NestJS Microservices

[NestJS](https://nestjs.com/) is a full-featured framework for building server-side applications, with a microservices module that supports multiple transports.

**How it works:**
NestJS microservices use a request-response or event-based pattern over various transports. Like Moleculer, routing and load balancing happen at the application level. NestJS adds an opinionated architecture with decorators, modules, and dependency injection.

**Strengths:**
- Comprehensive framework (HTTP, WebSockets, GraphQL, microservices)
- Strong TypeScript support with decorators
- Angular-inspired architecture (familiar to many)
- Enterprise adoption

**Trade-offs vs ProtoBus:**

| Aspect | NestJS | ProtoBus |
|--------|--------|----------|
| Scope | Full framework | Microservices messaging only |
| Architecture | Opinionated (modules, decorators) | Minimal (just services + proxies) |
| Learning curve | Steep | Gentle |
| Transport usage | Abstracted | Native RabbitMQ features |
| Serialization | JSON | Protobuf binary |
| Dependencies | 50+ packages | 3 packages |
| Message reliability | Transport-dependent | Guaranteed with acks |

**When to choose NestJS:**
- You want one framework for everything (HTTP API + microservices)
- You like Angular-style architecture
- You're building an enterprise application with many developers
- You need extensive documentation and community support

---

### Seneca

[Seneca](https://senecajs.org/) is a microservices toolkit focused on pattern matching and plugin architecture.

**How it works:**
Seneca routes messages based on pattern matching rather than service names. You define patterns like `{ role: 'math', cmd: 'sum' }` and Seneca routes to matching handlers. Transport is pluggable.

**Strengths:**
- Simple mental model (patterns, not services)
- Flexible plugin system
- Been around since 2010
- Good for decomposing monoliths

**Trade-offs vs ProtoBus:**

| Aspect | Seneca | ProtoBus |
|--------|--------|----------|
| Routing | Pattern matching (app-level) | Topic exchanges (broker-level) |
| Schema | None (dynamic patterns) | Required `.proto` contracts |
| Type safety | Runtime only | Compile-time |
| Serialization | JSON | Protobuf binary |
| Message delivery | Best effort | Guaranteed |
| Complexity | Can get messy with many patterns | Explicit service contracts |

**When to choose Seneca:**
- You prefer pattern-based over service-based thinking
- You're decomposing a monolith incrementally
- You want maximum flexibility in message routing

---

### MassTransit (.NET)

While not a Node.js framework, [MassTransit](https://masstransit.io/) deserves mention as it shares ProtoBus's philosophy—it's primarily RabbitMQ-native (with other transports added later) and leverages broker features directly.

If you're in the .NET ecosystem, MassTransit is the closest equivalent to what ProtoBus provides for Node.js. It's mature, widely used, and proves that the "broker-native" approach works at scale.

---

## Summary: When to Choose ProtoBus

Choose ProtoBus when:

- **Reliability is non-negotiable** — Financial systems, healthcare, anything where "message lost" isn't acceptable
- **Performance matters** — Binary serialization, no app-level routing overhead
- **You want RabbitMQ's full power** — Topic exchanges, DLX, priority queues, not just pub/sub
- **Type safety is important** — Compile-time contracts, not runtime surprises
- **You prefer simplicity** — 3 dependencies, minimal API surface, does one thing well
- **RabbitMQ is already in your stack** — Or you're happy to adopt it

Choose something else when:

- **Transport flexibility is required** — You might need to switch brokers
- **You need a full framework** — HTTP, GraphQL, WebSockets, the works
- **JSON is fine** — You don't need binary serialization benefits
- **You prefer conventions over contracts** — Pattern matching over `.proto` files

---

## Performance

ProtoBus should outperform transport-agnostic frameworks in:

- **Throughput** — Binary Protobuf serialization is faster and smaller than JSON
- **Latency** — No app-level routing overhead; broker handles it natively
- **Reliability under load** — Broker-managed queues vs app-level message tracking

We're planning to publish benchmarks comparing ProtoBus against Moleculer and NestJS in realistic scenarios:
- High message throughput with varying payload sizes
- Complex routing patterns
- Consumer failure and recovery
- Sustained load over time

Contributions and independent benchmarks are welcome!
