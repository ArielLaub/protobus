import { ServiceProxy } from 'protobus';

interface Orders {
    createOrder(request: { orderId?: string }): Promise<{ ok: boolean }>;
}

export async function create(proxy: ServiceProxy & Orders, orderId?: string) {
    try {
        return await proxy.createOrder({ orderId });
    } catch (error) {
        // Switch on the code you set, not on the error's class or its text.
        switch ((error as { code?: string }).code) {
            case 'VALIDATION_ERROR': return null;
            case 'NOT_FOUND': return null;
            default: throw error;
        }
    }
}
