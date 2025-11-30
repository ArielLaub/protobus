import EventListener from '../../lib/event_listener';
import MessageFactory from '../../lib/message_factory';
import { IConnection, Channel } from '../../lib/connection';
import { EventEmitter } from 'events';

// Mock channel with required methods
function createMockChannel(): Channel {
    return {
        prefetch: async () => {},
    } as unknown as Channel;
}

// Mock connection - using any to avoid complex type setup for tests
function createMockConnection(): IConnection {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
        isConnected: true,
        isReconnecting: false,
        connect: async () => ({} as any),
        disconnect: async () => {},
        openChannel: async () => createMockChannel(),
        closeChannel: async () => {},
        declareExchange: async () => {},
        declareQueue: async (_channel: Channel, queueName?: string) => queueName || 'mock-queue',
        bindQueue: async () => {},
        unbindQueue: async () => {},
        deleteQueue: async () => {},
        ack: async () => {},
        reject: async () => {},
        consume: async () => {},
        cancel: async () => {},
        purgeQueue: async () => {},
        publish: async () => {},
    }) as IConnection;
}

// Mock message factory
class MockMessageFactory {
    decodeEvent(buffer: Buffer): { data: any; type: string; topic: string } {
        const str = buffer.toString();
        const parsed = JSON.parse(str);
        return {
            data: parsed.data,
            type: parsed.type,
            topic: parsed.topic,
        };
    }
}

describe('EventListener', () => {
    let connection: IConnection;
    let messageFactory: MockMessageFactory;

    beforeEach(() => {
        connection = createMockConnection();
        messageFactory = new MockMessageFactory();
    });

    describe('Event handler invocation', () => {
        it('should call event handler exactly once per matching subscription', async () => {
            const listener = new EventListener(
                connection,
                messageFactory as unknown as MessageFactory
            );

            // Initialize the listener
            await listener.init(undefined, 'test-queue');

            // Track handler invocations
            const handlerCalls: string[] = [];

            // Subscribe a handler
            listener.subscribe('TestEvent', async (data, type, topic) => {
                handlerCalls.push(`handler1:${type}:${topic}`);
            }, 'EVENT.TestEvent');

            // Access the default handler to simulate an incoming event
            const defaultHandler = (listener as any).defaultHandler;

            // Create a mock event
            const mockEvent = Buffer.from(JSON.stringify({
                data: { message: 'test' },
                type: 'TestEvent',
                topic: 'EVENT.TestEvent',
            }));

            // Call the handler
            await defaultHandler(mockEvent, 'mock-correlation-id');

            // Handler should be called exactly once
            expect(handlerCalls).toHaveLength(1);
            expect(handlerCalls[0]).toBe('handler1:TestEvent:EVENT.TestEvent');
        });

        it('should call multiple handlers once each when router returns multiple', async () => {
            const listener = new EventListener(
                connection,
                messageFactory as unknown as MessageFactory
            );

            await listener.init(undefined, 'test-queue');

            const handlerCalls: string[] = [];

            // Mock the router to return multiple handlers
            const mockHandlers = [
                async (_data: any, type: string, _topic: string) => {
                    handlerCalls.push(`handler1:${type}`);
                },
                async (_data: any, type: string, _topic: string) => {
                    handlerCalls.push(`handler2:${type}`);
                },
            ];
            (listener as any).router = {
                match: () => mockHandlers,
            };

            const defaultHandler = (listener as any).defaultHandler;

            const mockEvent = Buffer.from(JSON.stringify({
                data: { message: 'test' },
                type: 'TestEvent',
                topic: 'EVENT.TestEvent',
            }));

            await defaultHandler(mockEvent, 'mock-correlation-id');

            // Each handler should be called exactly once (2 handlers = 2 calls)
            // With the bug, forEach + for-of would cause 4 calls (2*2)
            expect(handlerCalls).toHaveLength(2);
            expect(handlerCalls).toContain('handler1:TestEvent');
            expect(handlerCalls).toContain('handler2:TestEvent');
        });

        it('should not call handlers multiple times due to nested iteration bug', async () => {
            const listener = new EventListener(
                connection,
                messageFactory as unknown as MessageFactory
            );

            await listener.init(undefined, 'test-queue');

            let callCount = 0;

            // Mock the router to return 3 handlers
            const mockHandlers = [
                async () => { callCount++; },
                async () => { callCount++; },
                async () => { callCount++; },
            ];
            (listener as any).router = {
                match: () => mockHandlers,
            };

            const defaultHandler = (listener as any).defaultHandler;

            const mockEvent = Buffer.from(JSON.stringify({
                data: { message: 'test' },
                type: 'TestEvent',
                topic: 'EVENT.TestEvent',
            }));

            await defaultHandler(mockEvent, 'mock-correlation-id');

            // With the bug (forEach + nested for-of), we'd see 9 calls (3*3)
            // Without the bug, we should see exactly 3 calls
            expect(callCount).toBe(3);
        });
    });
});
