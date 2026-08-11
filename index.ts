export { default as Context, IContext, ContextOptions } from './lib/context';
export { default as MessageService, IMessageService, RetryOptions, HandledError, isHandledError } from './lib/message_service';
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
export { DisconnectedError } from './lib/message_dispatcher';
export { RetryQueueMismatchError } from './lib/message_listener';

// Streaming error types (server-streaming RPC — see docs/advanced/streaming.md).
// Missing from the 1.4.0 top-level export by mistake; restored here in 1.4.1.
export {
    StreamingError,
    StreamTimeoutError,
    StreamBackpressureError,
    StreamClosedError,
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

