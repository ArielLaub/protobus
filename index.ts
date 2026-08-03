export { default as Context, IContext, ContextOptions } from './lib/context';
export { default as MessageService, IMessageService, RetryOptions, HandledError, isHandledError } from './lib/message_service';
export { default as ProxiedService } from './lib/proxied_service';
export { default as ServiceProxy } from './lib/service_proxy';
export { default as EventListener } from './lib/event_listener';
export { default as RunnableService } from './lib/runnable_service';
export { set as setLogger, setLevel as setLogLevel, getLevel as getLogLevel, LogLevel, ILogger } from './lib/logger';
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

// Custom types
export {
    ICustomType,
    BigIntType,
    TimestampType,
    bigintToBytes,
    bytesToBigint
} from './lib/custom_types';

