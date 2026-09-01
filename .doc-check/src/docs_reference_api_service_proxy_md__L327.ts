import { ProxiedService } from 'protobus';

interface ICalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

export class CalculatorNode extends ProxiedService<ICalculatorMath> {
    public get ServiceName(): string { return 'Calculator.Math'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Calculator.proto'; }

    // Serves the contract...
    async add(request: { a: number; b: number }): Promise<{ result: number }> {
        return { result: request.a + request.b };
    }

    // ...and can call it on a sibling replica, typed.
    async addViaPeer(a: number, b: number): Promise<number> {
        const { result } = await this.proxy.add({ a, b });
        return result;
    }
}
