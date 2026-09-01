import { IContext, ServiceProxy, CallOptions, RpcTimeoutError, UnroutableError } from 'protobus';

// The transport arguments have to be in the interface YOU declare, or the
// compiler rejects them. A generated interface stops at `actor`; widen it when
// you need a per-call timeout or a priority.
interface CalculatorMath {
    add(
        request: { a: number; b: number },
        actor?: string,
        rpc?: boolean,
        timeoutMs?: number,
        options?: CallOptions,
    ): Promise<{ result: number }>;
}

async function callWithBudget(context: IContext) {
    const calculator = new ServiceProxy(context, 'Calculator.Math') as ServiceProxy & CalculatorMath;
    await calculator.init();

    try {
        await calculator.add({ a: 1, b: 2 }, undefined, true, 30000);
    } catch (error) {
        if (error instanceof RpcTimeoutError) {
            // Nobody replied in 30s. The request may still be being processed.
            console.error('no reply in time');
        } else if (error instanceof UnroutableError) {
            // Nothing is bound to REQUEST.Calculator.Math.add at all.
            console.error('no service is listening');
        } else {
            throw error;
        }
    }
}
