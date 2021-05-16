import IContext from '../../lib/context';
import ProxiedService from '../../lib/proxied_service';
import ServiceProxy from '../../lib/service_proxy';
import * as fs from 'fs';
import * as express from 'express';

export interface ITwoNumbers {
    num1: number;
    num2: number;
}

export interface INumberResult {
    result: number;
}

export interface ISimpleService {
    simpleMethod(request: ITwoNumbers): Promise<INumberResult>;
}
export class SimpleService extends ProxiedService<ISimpleService> {
    constructor(context: IContext) {
        super(context);
    }

    public get ServiceName(): string { return 'Simple1.Service'; }
    public get ProtoFileName(): string { return __dirname + '/simple1.proto'; }

    public async routeHttp(): Promise<express.Express> {
        const app = express();
        app.get('/simpleMethod', async (req: express.Request, res: express.Response) => {
            const num1 = parseInt(<string>req.query.num1);
            const num2 = parseInt(<string>req.query.num2);
            // not using proxy because we are just checking the http routing.
            const result = await this.proxy.simpleMethod({ num1, num2 });
            res.json(result);
        });
        return app;
    }

    async simpleMethod(request: any): Promise<any> {
        if (!request.num1 || !request.num2)
            throw new Error('invalid_params');

        return {
            result: request.num1 + request.num2
        };
    }
}

export class SimpleService2 extends ProxiedService<ISimpleService> {

    public get ServiceName(): string { return 'Simple2.Service'; }
    public get ProtoFileName(): string { return __dirname + '/simple2.proto'; }

    public async routeHttp(): Promise<express.Express> {
        const app = express();
        app.get('/simpleMethod', async (req: express.Request, res: express.Response) => {
            const num1 = parseInt(<string>req.query.num1);
            const num2 = parseInt(<string>req.query.num2);
            // not using proxy because we are just checking the http routing.
            const result = await this.proxy.simpleMethod({ num1, num2 });
            res.json(result);
        });
        return app;
    }

    async simpleMethod(request: any): Promise<any> {
        if (!request.num1 || !request.num2)
            throw new Error('invalid_params');

        return {
            result: request.num1 * request.num2
        };
    }
}