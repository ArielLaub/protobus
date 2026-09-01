import { MessageService, IContext, ServiceProxy } from 'protobus';

interface Payments { charge(req: { amount: number }): Promise<{ ok: boolean }>; }

export class OrderService extends MessageService {
    private payments: ServiceProxy & Payments;

    public get ServiceName(): string { return 'Orders.Service'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Orders.proto'; }

    constructor(context: IContext) {
        super(context, { maxConcurrent: 10 });
        this.payments = new ServiceProxy(context, 'Payments.Service') as ServiceProxy & Payments;
    }

    async init(): Promise<void> {
        await super.init();
        await this.payments.init();
    }

    async create(request: { total: number }): Promise<{ orderId: string }> {
        await this.payments.charge({ amount: request.total });
        return { orderId: 'o-1' };
    }
}
