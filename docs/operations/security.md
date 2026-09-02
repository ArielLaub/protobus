# Security model

What protobus does and does not guarantee, and where the responsibility sits.

## `actor` is metadata, not authentication

Every request carries an optional `actor` string, and handlers receive it:

<!-- doc-check: ignore why="an excerpt, not a standalone file" -->
```typescript
async add(request: AddRequest, actor?: string): Promise<AddResponse> {
    // `actor` is whatever the CALLER put there. Nothing verified it.
}
```

`actor` is set by the client and forwarded verbatim. Nothing signs it, nothing
checks it, and any process that can publish to the bus can publish any value.
It is useful for tracing and audit logging. It is **not** an identity claim,
and it must never be the thing that decides whether an operation is allowed.

If a caller could benefit from lying about `actor`, treat it as already having
lied.

For real authorisation, put the control where it can be enforced:

- **Per-service broker credentials.** Give each service its own RabbitMQ user
  rather than sharing one. A compromised service is then bounded by what its
  own user can reach.
- **Per-service vhosts and permissions.** Ordinary `set_permissions` regexes
  match **resource names** — exchanges and queues — not routing keys. Every RPC
  publisher writes to the one shared `proto.bus` exchange, so write permission
  on that exchange authorises publishing *any* `REQUEST.*` key, for any service.
  Vhost permissions bound which exchanges and queues a service can reach; on
  their own they do not stop one service addressing another.
- **Topic permissions.** This is the control that actually stops one service
  impersonating another. `set_topic_permissions` is a separate mechanism, and
  the only one that takes the routing key into account when authorising a
  publish to a topic exchange. It must be configured explicitly: with no topic
  permissions defined — the state of a fresh installation — publishing to a
  topic exchange is always authorised once resource access passes.

  ```bash
  # billing-svc may publish only its own requests, and read its own replies
  # and events. proto.bus is a topic exchange, which is what makes this apply.
  rabbitmqctl set_topic_permissions -p /prod billing-svc proto.bus \
      "^REQUEST\.Billing\..*" "^(REQUEST\.Billing|EVENT)\..*"
  ```

  Pair it with the library's own dispatch check, which refuses a message whose
  body method disagrees with the routing key it arrived on (see
  [Migration](../migration.md#dispatch-is-bound-to-the-routing-key-and-to-the-contract)).
  The broker decides which keys a service may publish; the service refuses a
  body that contradicts its key. Neither is a substitute for the other — without
  topic permissions the broker enforces nothing about routing keys, and without
  the dispatch check a caller who is allowed one key could still ask for another
  method.
- **AMQPS.** Without TLS, credentials and every message body cross the network
  in the clear. Use `amqps://` anywhere the broker is not on loopback.
- **A signed token in the payload**, verified by the handler, if you need
  end-user identity rather than service identity.

## What is redacted, and what is not

Two different exposure surfaces, treated differently on purpose.

**Redacted unconditionally**, because they escape into systems with looser
access control than the bus itself:

- **Connection URLs.** Logged with the password replaced (`amqp://user:***@…`).
  Scheme, user, host, port and vhost are kept so the line stays useful.
- **Message and event payloads.** The framework logs sizes, types and
  correlation IDs, never bodies. Log aggregators typically have far broader
  read access and longer retention than your broker credentials.
- **`x-last-error`** in retry and DLQ metadata. Carries the error class and
  `code`, never the message, because this header persists in a queue and is
  read by dashboards and queue browsers.

**Not redacted by default:** the message of an unhandled error travelling back
to the calling service. A protobus caller is another of your own services,
already inside the trust boundary and already holding broker credentials, so
suppressing this by default would degrade every consumer's error reporting to
guard against a downstream bug.

Set `PROTOBUS_EXPOSE_INTERNAL_ERRORS=false` where that assumption does not
hold — chiefly a gateway that relays protobus errors onward to untrusted
clients. Callers then receive a generic message plus the correlation ID, while
the real error still reaches the service's own log.

A gateway should map errors to a public vocabulary deliberately rather than
relaying whatever it received. The setting is a safety net, not a substitute.

## Delivery guarantees

protobus provides **at-least-once** delivery with publisher confirms. It does
not provide exactly-once effects, and no broker-level mechanism can.

A publish resolves only when RabbitMQ confirms it. Two failure modes are
deliberately reported as *ambiguous* rather than as failures:

- `PublishConfirmTimeoutError` — no confirm arrived in time.
- `ChannelClosedError` — the channel closed with the publish unconfirmed.

In both cases the broker may or may not have stored the message. Retrying can
therefore duplicate it. Every publish carries a stable `messageId`, preserved
across retries, so consumers can deduplicate.

**Handlers should be idempotent.** This is a requirement of the delivery
contract, not a nice-to-have — particularly for handlers that also write to a
database, where the message and the transaction can succeed independently.
