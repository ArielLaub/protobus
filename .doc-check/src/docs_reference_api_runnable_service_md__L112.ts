import { RunnableService } from 'protobus';

interface Pool { end(): Promise<void>; }

export class OrderService extends RunnableService {
    private pool: Pool;

    public get ServiceName(): string { return 'Orders.Service'; }

    async create(request: { total: number }): Promise<{ id: string }> {
        return { id: String(request.total) };
    }

    protected async cleanup(): Promise<void> {
        await this.pool.end();
    }
}
