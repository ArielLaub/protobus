import { RunnableService } from 'protobus';

class ReportingService extends RunnableService {
    public get ServiceName(): string { return 'Reporting.Service'; }

    public async init(): Promise<void> {
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.store(event);
        });

        // Same topic. Both handlers run for every delivery.
        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            await this.countIt(event);
        });
    }

    private async store(_event: any): Promise<void> { /* ... */ }
    private async countIt(_event: any): Promise<void> { /* ... */ }
}
