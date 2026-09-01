"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportService = void 0;
const protobus_1 = require("protobus");
class ReportService extends protobus_1.MessageService {
    get ServiceName() { return 'Reports.Service'; }
    get ProtoFileName() { return __dirname + '/proto/Reports.proto'; }
    async generate(request, actor, correlationId, context) {
        if (context?.redelivered) {
            // This exact message has been delivered before. messageId is stable
            // across every retry hop, so it is what deduplication keys on.
            console.warn(`redelivery of ${context.messageId} for ${actor}`);
        }
        let written = 0;
        for (let i = 0; i < request.rows; i++) {
            // The signal fires on the processing timeout and on caller
            // cancellation. Nothing preempts a running function, so a handler
            // that never checks it simply runs to the end.
            if (context?.signal?.aborted)
                break;
            written++;
        }
        return { written };
    }
}
exports.ReportService = ReportService;
