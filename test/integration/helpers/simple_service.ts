import { IContext } from '../../../lib/context';
import ProxiedService from '../../../lib/proxied_service';

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

    async simpleMethod(request: any): Promise<any> {
        if (!request.num1 || !request.num2)
            throw new Error('invalid_params');

        return {
            result: request.num1 * request.num2
        };
    }
}
