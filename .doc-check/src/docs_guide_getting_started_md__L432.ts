import { ProxiedService, IContext } from 'protobus';

interface ICalculatorMath {
    add(request: { a: number; b: number }): Promise<{ result: number }>;
}

export class CalculatorNode extends ProxiedService<ICalculatorMath> {
    public get ServiceName(): string { return 'Calculator.Math'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Calculator.proto'; }

    async addViaPeer(a: number, b: number): Promise<number> {
        const { result } = await this.proxy.add({ a, b });
        return result;
    }
}
