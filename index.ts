export { default as Context, IContext, ContextOptions } from './lib/context';
export { default as MessageService, IMessageService, IMessageServiceOptions, RetryOptions, HandledError, isHandledError } from './lib/message_service';

// The .proto backing a service could not be read, or declares no service
// matching its ServiceName. Exported so the first failure a new service hits
// can be caught by type rather than by matching on the message text.
export { MissingProto } from './lib/message_service';
export { default as ProxiedService } from './lib/proxied_service';
export { default as ServiceProxy } from './lib/service_proxy';
// EventHandler is the type of the second argument to subscribeEvent(). It
// takes THREE arguments — (event, type, topic) — which is exactly why it needs
// exporting: every user was redeclaring it by hand, and a hand-written
// one-argument version compiles fine and silently ignores the other two.
export { default as EventListener, EventHandler } from './lib/event_listener';
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

// The 4th argument every service method and message handler receives: the
// AbortSignal for the processing timeout, the routing key the broker actually
// delivered on, the stable messageId to deduplicate against, and whether this
// is a redelivery. Part of the public signature, so it is part of the public
// surface.
export { MessageHandlerContext, MessageHandler, MessageHandlerResult } from './lib/connection';
export { DisconnectedError, CallOptions, StreamOptions } from './lib/message_dispatcher';

// CallOptions.messageId sets the identity of a single publish, so a caller
// that republishes after an AMBIGUOUS outcome can be recognised as sending the
// same logical message rather than a second one. Rejected when blank, with
// InvalidMessageIdError, rather than quietly falling back to a fresh UUID.
export { InvalidMessageIdError } from './lib/message_dispatcher';

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

// Custom types. registerType() is idempotent: re-registering a name this
// factory already holds refreshes its codec and returns the existing message
// class. Only a definition that disagrees about wireType is refused, with
// CustomTypeConflictError, because the generated protobuf message is fixed at
// first registration and could not follow the change.
export {
    ICustomType,
    BigIntType,
    TimestampType,
    CustomTypeConflictError,
    bigintToBytes,
    bytesToBigint
} from './lib/custom_types';

