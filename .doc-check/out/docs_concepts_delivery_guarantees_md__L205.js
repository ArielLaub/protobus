"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const protobus_1 = require("protobus");
class ReportService extends protobus_1.RunnableService {
    constructor(context) {
        // 5 retries, 2s apart: 6 handler runs and 10s of parking, worst case.
        super(context, { retry: { maxRetries: 5, retryDelayMs: 2000 }, maxConcurrent: 10 });
    }
    get ServiceName() { return 'Reports.Service'; }
}
