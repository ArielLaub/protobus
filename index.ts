export { default as Context, IContext, ContextOptions } from './lib/context';
export { default as MessageService, IMessageService, IMessageServiceOptions, RetryOptions, HandledError, isHandledError } from './lib/message_service';
export { default as ProxiedService } from './lib/proxied_service';
export { default as ServiceProxy } from './lib/service_proxy';
export { default as EventListener } from './lib/event_listener';
export { default as RunnableService } from './lib/runnable_service';
export { set as setLogger, setLevel as setLogLevel, getLevel as getLogLevel, LogLevel, ILogger } from './lib/logger';

// Structured logging. A sink passed to setLogger() that also implements
// `log(record)` receives LogRecord objects; one that does not keeps receiving
// formatted strings. setDiagnosticsSerializer() is the opt-in hook for
// attaching payload detail, which is never assembled without it.
export {
    Log,
    LogRecord,
    LogFields,
    LogDiagnostics,
    LogOutcome,
    IStructuredLogger,
    DiagnosticsSerializer,
    setDiagnosticsSerializer,
    formatLogRecord,
} from './lib/logger';
export { ReconnectionOptions, ReconnectionError } from './lib/connection';

// Reconnection coordination. A publish issued while the connection is being
// restored waits for it rather than failing, and rejects with NotReadyError if
// the connection is closed or gives up first. Restorer is the hook a custom
// IConnection implements to take part in that coordination.
export { NotReadyError, Restorer } from './lib/connection';
export { DisconnectedError, CallOptions, StreamOptions } from './lib/message_dispatcher';

// Message priority (opt-in). `maxPriority` on IMessageServiceOptions declares
// the service's request queue as a RabbitMQ priority queue; `priority` on
// CallOptions sets a single message's level. Both are absent from the wire
// unless set, so an upgraded process talks to an un-upgraded one unchanged.
// See docs/advanced/priority.md.
export { InvalidPriorityError } from './lib/priority';

// Config carries the named priority levels (PRIORITY_NORMAL / PRIORITY_HIGH /
// PRIORITY_CONTROL / RECOMMENDED_MAX_PRIORITY) as well as the environment
// defaults. Exported so callers can name a level instead of writing a bare
// integer, and so the constants match protobus-py's Config exactly.
export { default as Config } from './lib/config';
export { RetryQueueMismatchError } from './lib/message_listener';

// A message this service could not understand — it did not decode, or it named
// something the service does not serve. A HandledError, so it is answered
// rather than retried: the same bytes fail the same way on every redelivery.
export { ProtocolError, InternalServiceError } from './lib/errors';

// Streaming error types (server-streaming RPC — see docs/advanced/streaming.md).
// Missing from the 1.4.0 top-level export by mistake; restored here in 1.4.1.
export {
    StreamingError,
    StreamTimeoutError,
    StreamBackpressureError,
    StreamClosedError,
    StreamSequenceError,
    RpcTimeoutError,
} from './lib/errors';

// Publish outcomes. A resolved publish() means the broker confirmed the
// message; these are the ways that can fail. PublishConfirmTimeoutError and
// ChannelClosedError are AMBIGUOUS — the message may or may not have been
// stored — so retrying either can duplicate. Deduplicate on `messageId`.
export {
    PublishError,
    PublishNackedError,
    UnroutableError,
    PublishConfirmTimeoutError,
    ChannelClosedError,
} from './lib/errors';

// Custom types
export {
    ICustomType,
    BigIntType,
    TimestampType,
    bigintToBytes,
    bytesToBigint
} from './lib/custom_types';

