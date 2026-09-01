import * as path from 'path';
import { RunnableService } from 'protobus';

export class ReportService extends RunnableService {
    public get ServiceName(): string { return 'Reports.Service'; }

    // Absolute, and relative to this file rather than to the process.
    public get ProtoFileName(): string {
        return path.join(__dirname, 'proto', 'Reports.proto');
    }
}
