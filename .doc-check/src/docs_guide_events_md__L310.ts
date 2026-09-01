import { RunnableService } from 'protobus';

class BillingService extends RunnableService {
    public get ServiceName(): string { return 'Billing.Service'; }

    public async init(): Promise<void> {
        await super.init();

        await this.subscribeEvent('Orders.OrderCreated', async (event) => {
            try {
                await this.charge(event);
            } catch (error) {
                // Nothing above this line will retry, so failure has to be
                // recorded here or it is recorded nowhere.
                await this.parkForReplay(event, error);
            }
        });
    }

    private async charge(_event: any): Promise<void> { /* ... */ }
    private async parkForReplay(_event: any, _error: unknown): Promise<void> { /* ... */ }
}
