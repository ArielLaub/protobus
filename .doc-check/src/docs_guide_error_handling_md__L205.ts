import { RunnableService } from 'protobus';

export class OrderProjection extends RunnableService {
    public get ServiceName(): string { return 'Orders.Projection'; }

    async init(): Promise<void> {
        await super.init();
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.project(event);
            } catch (error) {
                // Nothing downstream will retry this. Persist enough to
                // reprocess deliberately, and do not rethrow expecting a requeue.
                await this.recordFailure(event, error);
            }
        });
    }

    private async project(_event: unknown): Promise<void> { /* ... */ }
    private async recordFailure(_event: unknown, _error: unknown): Promise<void> { /* ... */ }
}
