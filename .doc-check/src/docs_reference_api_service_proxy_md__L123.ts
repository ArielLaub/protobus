import { IContext, ServiceProxy, Config } from 'protobus';

interface AuditService {
    record(
        request: { event: string },
        actor?: string,
        rpc?: boolean,
        timeoutMs?: number,
        options?: { priority?: number },
    ): Promise<any>;
}

async function main(context: IContext) {
    const audit = new ServiceProxy(context, 'Audit.Service') as ServiceProxy & AuditService;
    await audit.init();

    // Fire-and-forget: resolves once the broker confirms the publish. The
    // resolved value is {} — there is no reply to decode.
    await audit.record({ event: 'login' }, 'user-123', false);

    // A control message that should overtake a bulk backlog. Only has an
    // effect on a queue the service declared with maxPriority.
    await audit.record(
        { event: 'shutdown' }, 'ops', true, 5000,
        { priority: Config.PRIORITY_CONTROL },
    );
}
