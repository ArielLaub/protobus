import { Context, ICustomType, RunnableService } from 'protobus';
// ---- from docs/reference/custom-types.md:85 (needs=money-type) ----


export interface Money { currency: string; cents: number }

export const MoneyType: ICustomType<Money> = {
    name: 'money',            // the token that appears in the .proto
    wireType: 'string',       // how it is actually encoded
    tsType: 'Money',          // what `protobus generate` writes into the .d.ts
    encode: (value: Money) => `${value.currency}:${value.cents}`,
    decode: (data: string) => {
        const [currency, cents] = String(data).split(':');
        return { currency, cents: Number(cents) };
    },
};

export async function start(): Promise<Context> {
    const context = new Context();
    context.factory.registerType(MoneyType);          // BEFORE init, see below
    await context.init('amqp://guest:guest@localhost:5672/', ['./proto']);
    return context;
}


export abstract class BillingApi extends RunnableService {
    get ServiceName() { return 'Billing.Api'; }

    async issue(request: { id?: string; total?: Money }) {
        const total = request.total ?? { currency: 'USD', cents: 0 };
        return { id: request.id, total: { ...total, cents: total.cents + 50 } };
    }
}
