import { MessageService } from 'protobus';

// MessageHandlerContext is not re-exported from the package index, so the
// shape is written out here. It lives in lib/connection.ts.
interface HandlerContext {
    signal: AbortSignal;
    routingKey: string;
    messageId?: string;
    redelivered: boolean;
}

export class ReportService extends MessageService {
    public get ServiceName(): string { return 'Reports.Service'; }
    public get ProtoFileName(): string { return __dirname + '/proto/Reports.proto'; }

    async generate(
        request: { rows: number },
        actor?: string,
        correlationId?: string,
        context?: HandlerContext,
    ): Promise<{ written: number }> {
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
            if (context?.signal?.aborted) break;
            written++;
        }
        return { written };
    }
}
