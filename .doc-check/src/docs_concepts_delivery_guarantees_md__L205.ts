import { RunnableService, IContext } from 'protobus';

class ReportService extends RunnableService {
    constructor(context: IContext) {
        // 5 retries, 2s apart: 6 handler runs and 10s of parking, worst case.
        super(context, { retry: { maxRetries: 5, retryDelayMs: 2000 }, maxConcurrent: 10 });
    }

    get ServiceName(): string { return 'Reports.Service'; }
}
