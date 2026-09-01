import { MessageService } from 'protobus';

const alreadyDone = new Set<string>();

class OrdersService extends MessageService {
    get ServiceName(): string { return 'Orders.Service'; }
    get ProtoFileName(): string { return './protos/orders.proto'; }

    async create(
        request: { customerId: string },
        actor: string,
        correlationId: string,
        ctx?: { messageId?: string; redelivered: boolean },
    ): Promise<{ ok: boolean }> {
        // messageId is stable across every redelivery and every retry hop.
        const key = ctx?.messageId;
        if (key && alreadyDone.has(key)) {
            return { ok: true }; // already applied; do not charge the card twice
        }
        if (key) { alreadyDone.add(key); }
        return { ok: true };
    }
}
