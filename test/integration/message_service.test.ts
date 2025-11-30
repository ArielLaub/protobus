import * as protobuf from 'protobufjs';

import ServiceProxy from '../../lib/service_proxy';
import MessageService from '../../lib/message_service';
import Context, { IContext } from '../../lib/context';
import { Logger } from '../../lib/logger';

const proto = `syntax = "proto3";
package Simple;

message Request {
    int32 num1 = 1;
    int32 num2 = 2;
}

message Response {
    int32 result = 1;
}

message Event {
    string message = 1;
}

message MultiEvent {
    int32 count = 1;
}

service Service {
    rpc simpleMethod(Simple.Request) returns(Simple.Response);
}`;

class TestService extends MessageService {
    constructor(context: IContext) {
        super(context, { maxConcurrent: 1 });
        Logger.info('simple service initialized');
    }

    public async init() {
        await super.init();
    }

    public get ServiceName(): string { return 'Simple.Service'; }
    public get ProtoFileName(): string { return ''; }
    public get Proto(): string { return proto; }

    public async simpleMethod(request: any): Promise<any> {
        if (!request.num1 || !request.num2)
            throw new Error('invalid_params');

        return {
            result: request.num1 + request.num2
        };
    }
}

const AMQP_CONNECTION_STRING = 'amqp://guest:guest@localhost:5672/';

describe('MessageService tests suite', () => {
    let theService: TestService;
    let client: any;
    let context: Context;

    beforeAll(async () => {
        context = new Context();
        await context.init(AMQP_CONNECTION_STRING, []);
        // load proto from string in a hacky way. got this idea from protobuf.js tests
        (protobuf.parse as any).filename = 'simple.proto';
        (context.factory as any).root = protobuf.parse(proto).root;
        // init the micro service instance
        theService = new TestService(context);
        await theService.init();
        // initiate the stub/proxy class to this service
        client = new ServiceProxy(context, theService.ServiceName);
        await client.init();
    });

    afterAll(async () => {
        if (context && context.isConnected) {
            await context.connection.disconnect();
        }
    });

    it('should test an RPC call', async () => {
        const res = await client.simpleMethod({ num1: 1, num2: 2});
        expect(res).toHaveProperty('result', 3);
    });

    it('should test an Event call', async () => {
        await new Promise<void>(async (resolve) => {
            const handler = async (event: any): Promise<any> => {
                expect(event).toHaveProperty('message', 'hello');
                resolve();
            };
            await theService.subscribeEvent('Simple.Event', handler);
            await theService.publishEvent('Simple.Event', { message: 'hello' });
        });
    });

    it('should test * wildcard subscriptions', async () => {
        await new Promise<void>(async (resolve) => {
            let i = 1;
            const handler = async (event: any): Promise<any> => {
                expect(event).toHaveProperty('count', i);
                if (i++ === 2) resolve();
            };
            await theService.subscribeEvent('Simple.MultiEvent', handler, 'CUSTOM.*.TOPIC');
            await theService.publishEvent('Simple.MultiEvent', { count: 1 }, 'CUSTOM.1.TOPIC');
            await theService.publishEvent('Simple.MultiEvent', { count: 2 }, 'CUSTOM.2.TOPIC');
        });
    });

    it('should test error exceptions flowing back to client', async () => {
        await expect(client.simpleMethod({ no: 'yes' })).rejects.toMatchObject({
            message: 'invalid_params'
        });
    });

    it('should test TS interface export', async () => {
        const source = context.factory.exportTS('Simple.Service');
        expect(source).toBe(
`export namespace Simple {
    export interface IRequest {
        num1?: (number | null);
        num2?: (number | null);
    }

    export interface IResponse {
        result?: (number | null);
    }


    export interface Service {
        simpleMethod(request: IRequest): Promise<IResponse>;
    }

}

`);
    });
});
