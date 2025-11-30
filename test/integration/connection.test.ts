import Connection, {
    ReconnectionOptions,
    AlreadyConnectedError,
    ReconnectionError
} from '../../lib/connection';
import { DisconnectedError } from '../../lib/message_dispatcher';

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('Connection tests suite', () => {
    let connection: Connection;

    beforeEach(() => {
        connection = new Connection();
    });

    afterEach(async () => {
        if (connection && connection.isConnected) {
            await connection.disconnect();
        }
    });

    describe('Basic connection', () => {
        it('should connect successfully', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);
            expect(connection.isConnected).toBe(true);
            expect(connection.isReconnecting).toBe(false);
        });

        it('should throw AlreadyConnectedError when connecting twice', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);

            await expect(connection.connect(AMQP_CONNECTION_STRING))
                .rejects
                .toThrow(AlreadyConnectedError);
        });

        it('should disconnect cleanly', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);
            expect(connection.isConnected).toBe(true);

            await connection.disconnect();
            expect(connection.isConnected).toBe(false);
        });

        it('should open and close channels', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);

            const channel = await connection.openChannel();
            expect(channel).toBeDefined();

            await connection.closeChannel(channel);
        });
    });

    describe('Reconnection options', () => {
        it('should use default reconnection options', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);

            // Access private property for testing
            const options = (connection as any).reconnectionOptions;
            expect(options.maxRetries).toBe(10);
            expect(options.initialDelayMs).toBe(1000);
            expect(options.maxDelayMs).toBe(30000);
            expect(options.backoffMultiplier).toBe(2);
        });

        it('should accept custom reconnection options', async () => {
            const customOptions: ReconnectionOptions = {
                maxRetries: 5,
                initialDelayMs: 500,
                maxDelayMs: 10000,
                backoffMultiplier: 1.5,
            };

            await connection.connect(AMQP_CONNECTION_STRING, customOptions);

            const options = (connection as any).reconnectionOptions;
            expect(options.maxRetries).toBe(5);
            expect(options.initialDelayMs).toBe(500);
            expect(options.maxDelayMs).toBe(10000);
            expect(options.backoffMultiplier).toBe(1.5);
        });

        it('should merge partial options with defaults', async () => {
            await connection.connect(AMQP_CONNECTION_STRING, { maxRetries: 3 });

            const options = (connection as any).reconnectionOptions;
            expect(options.maxRetries).toBe(3);
            expect(options.initialDelayMs).toBe(1000); // default
        });
    });

    describe('Connection events', () => {
        it('should emit disconnected event on connection close', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);

            const disconnectedPromise = new Promise<void>((resolve) => {
                connection.on('disconnected', () => resolve());
            });

            // Simulate connection loss by accessing internal handle
            const handle = (connection as any).handle;
            handle.emit('close');

            await expect(disconnectedPromise).resolves.toBeUndefined();
        });

        it('should emit error event on connection error', async () => {
            await connection.connect(AMQP_CONNECTION_STRING);

            const errorPromise = new Promise<Error>((resolve) => {
                connection.on('error', (err) => resolve(err));
            });

            const testError = new Error('Test connection error');
            const handle = (connection as any).handle;
            handle.emit('error', testError);

            const emittedError = await errorPromise;
            expect(emittedError.message).toBe('Test connection error');
        });
    });

    describe('Connection state', () => {
        it('should report isConnected correctly', async () => {
            expect(connection.isConnected).toBe(false);

            await connection.connect(AMQP_CONNECTION_STRING);
            expect(connection.isConnected).toBe(true);

            await connection.disconnect();
            expect(connection.isConnected).toBe(false);
        });

        it('should report isReconnecting correctly', async () => {
            expect(connection.isReconnecting).toBe(false);

            await connection.connect(AMQP_CONNECTION_STRING);
            expect(connection.isReconnecting).toBe(false);
        });
    });
});

describe('Connection reconnection behavior', () => {
    describe('Reconnection scheduling', () => {
        it('should emit reconnecting event with attempt and delay info', async () => {
            const connection = new Connection();
            await connection.connect(AMQP_CONNECTION_STRING, {
                maxRetries: 1,
                initialDelayMs: 100,
            });

            const events: any[] = [];
            connection.on('reconnecting', (info) => {
                events.push(info);
            });

            // Trigger disconnect without manual flag
            (connection as any).manualDisconnect = false;
            (connection as any)._isConnected = false;
            (connection as any)._scheduleReconnect();

            // Wait a bit for the reconnecting event to fire
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(events).toHaveLength(1);
            expect(events[0]).toHaveProperty('attempt', 1);
            expect(events[0]).toHaveProperty('delay');
            expect(events[0].delay).toBeGreaterThanOrEqual(100);

            // Cleanup - disconnect cancels the reconnect timer
            await connection.disconnect();

            // Wait for any pending reconnection attempt to complete or be cancelled
            await new Promise(resolve => setTimeout(resolve, 200));
        });

        it('should not reconnect after manual disconnect', async () => {
            const connection = new Connection();
            await connection.connect(AMQP_CONNECTION_STRING);

            let reconnectingCalled = false;
            connection.on('reconnecting', () => {
                reconnectingCalled = true;
            });

            // Manual disconnect
            await connection.disconnect();

            // Try to trigger reconnect
            (connection as any)._scheduleReconnect();

            await new Promise(resolve => setTimeout(resolve, 100));
            expect(reconnectingCalled).toBe(false);
        });

        it('should emit error after max retries exceeded', async () => {
            const connection = new Connection();

            // Set up to test max retries
            (connection as any).reconnectionOptions = {
                maxRetries: 1,
                initialDelayMs: 10,
                maxDelayMs: 100,
                backoffMultiplier: 1,
            };
            (connection as any).reconnectAttempts = 1;
            (connection as any).manualDisconnect = false;
            (connection as any)._isReconnecting = false;

            const errorPromise = new Promise<Error>((resolve) => {
                connection.on('error', (err) => resolve(err));
            });

            (connection as any)._scheduleReconnect();

            const emittedError = await errorPromise;
            expect(emittedError).toBeInstanceOf(ReconnectionError);
        });
    });
});

describe('DisconnectedError', () => {
    it('should have correct message', () => {
        const error = new DisconnectedError();
        expect(error.message).toBe('Connection lost during RPC call');
    });

    it('should be an instance of Error', () => {
        const error = new DisconnectedError();
        expect(error).toBeInstanceOf(Error);
    });
});
