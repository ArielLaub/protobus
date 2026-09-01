"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReportService = void 0;
const protobus_1 = require("protobus");
class ReportService extends protobus_1.RunnableService {
    get ServiceName() { return 'Reports.Service'; }
    async build(request) {
        const upstream = await fetch('https://example.invalid/' + request.id);
        if (upstream.status >= 500) {
            // Plain Error: the upstream may well be back in five seconds.
            throw new Error(`upstream returned ${upstream.status}`);
        }
        return { url: await upstream.text() };
    }
}
exports.ReportService = ReportService;
