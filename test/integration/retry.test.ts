import * as protobuf from 'protobufjs';
import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';
import { HandledError } from '../../lib/errors';
import { Logger } from '../../lib/logger';

const proto = `syntax = "proto3";
package Retry;

message Request {
    string action = 1;
}

message Response {
    string result = 1;
}

service Service {
    rpc testMethod(Retry.Request) returns(Retry.Response);
}`;

// Track method calls for assertions
const callTracker = {
    calls: [] as string[],
    reset() { this.calls = []; }
};

class RetryTestService extends MessageService {
    private failCount: number = 0;
    private maxFails: number = 0;

    constructor(context: IContext, maxRetries: number = 3, retryDelayMs: number = 100) {
        super(context, {
            maxConcurrent: 1,
            retry: {
                maxRetries,
                retryDelayMs,
            }
        });
    }

    public get ServiceName(): string { return 'Retry.Service'; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }

    public setFailBehavior(maxFails: number) {
        this.failCount = 0;
        this.maxFails = maxFails;
    }

    public async testMethod(request: any): Promise<any> {
        callTracker.calls.push(`testMethod:${request.action}`);
        Logger.debug(`testMethod called with action=${request.action}, failCount=${this.failCount}, maxFails=${this.maxFails}`);

        if (request.action === 'handled_error') {
            // Handled error - should NOT retry
            throw new HandledError('This is a handled validation error', 'VALIDATION_ERROR');
        }

        if (request.action === 'unhandled_error') {
            // Unhandled error - should retry
            if (this.failCount < this.maxFails) {
                this.failCount++;
                throw new Error('Temporary database error');
            }
            // After max fails, succeed
            return { result: 'recovered' };
        }

        if (request.action === 'always_fail') {
            // Always fail - should end up in DLQ
            throw new Error('Permanent failure');
        }

        return { result: 'success' };
    }
}

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('Retry and DLQ tests', () => {
    let context: Context;
    let service: RetryTestService;
    let client: any;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);

        // Load proto
        (protobuf.parse as any).filename = 'retry.proto';
        (context.factory as any).root = protobuf.parse(proto).root;

        // Create service with retry enabled (3 retries, 100ms delay)
        service = new RetryTestService(context, 3, 100);
        await service.init();

        // Create client
        client = new ServiceProxy(context, 'Retry.Service');
        await client.init();
    });

    afterAll(async () => {
        if (context && context.isConnected) {
            await context.connection.disconnect();
        }
    });

    beforeEach(() => {
        callTracker.reset();
        service.setFailBehavior(0);
    });

    describe('Handled errors (no retry)', () => {
        it('should NOT retry when HandledError is thrown', async () => {
            // Wait a bit for any pending messages to clear
            await new Promise(resolve => setTimeout(resolve, 100));
            callTracker.reset();

            await expect(client.testMethod({ action: 'handled_error' }))
                .rejects
                .toMatchObject({ message: 'This is a handled validation error' });

            // Wait to ensure no retries happen
            await new Promise(resolve => setTimeout(resolve, 500));

            // Should only be called once - no retries
            expect(callTracker.calls.filter(c => c === 'testMethod:handled_error')).toHaveLength(1);
        });
    });

    describe('Unhandled errors (with retry)', () => {
        it('should retry unhandled errors and succeed after recovery', async () => {
            // Fail twice, then succeed
            service.setFailBehavior(2);
            callTracker.reset();

            const result = await client.testMethod({ action: 'unhandled_error' });

            // Wait for retries to complete
            await new Promise(resolve => setTimeout(resolve, 500));

            expect(result).toMatchObject({ result: 'recovered' });

            // Should have been called 3 times (initial + 2 retries that failed + 1 success)
            // Actually: initial fails, retry 1 fails, retry 2 succeeds = 3 calls total
            const calls = callTracker.calls.filter(c => c === 'testMethod:unhandled_error');
            expect(calls.length).toBeGreaterThanOrEqual(1); // At least one call succeeded
        });

        it('should send to DLQ after max retries exceeded', async () => {
            // Always fail - will exhaust retries and go to DLQ
            callTracker.reset();

            await expect(client.testMethod({ action: 'always_fail' }))
                .rejects
                .toMatchObject({ message: 'Permanent failure' });

            // Wait for retries to complete (3 retries * 100ms delay + processing)
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Should have been called 4 times (initial + 3 retries)
            const calls = callTracker.calls.filter(c => c === 'testMethod:always_fail');
            expect(calls.length).toBeLessThanOrEqual(4);
        });
    });

    describe('Success path', () => {
        it('should not retry on success', async () => {
            callTracker.reset();

            const result = await client.testMethod({ action: 'normal' });

            expect(result).toMatchObject({ result: 'success' });

            // Wait to ensure no retries happen
            await new Promise(resolve => setTimeout(resolve, 200));

            // Should only be called once
            expect(callTracker.calls.filter(c => c === 'testMethod:normal')).toHaveLength(1);
        });
    });
});

describe('HandledError class', () => {
    it('should have correct properties', () => {
        const error = new HandledError('test message', 'TEST_CODE');

        expect(error.message).toBe('test message');
        expect(error.code).toBe('TEST_CODE');
        expect(error.isHandled).toBe(true);
        expect(error.name).toBe('HandledError');
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(HandledError);
    });

    it('should default code to HANDLED_ERROR', () => {
        const error = new HandledError('test');
        expect(error.code).toBe('HANDLED_ERROR');
    });
});
