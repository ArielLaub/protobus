import { RunnableService } from 'protobus';

export class ReportService extends RunnableService {
    public get ServiceName(): string { return 'Reports.Service'; }

    async build(request: { id: string }): Promise<{ url: string }> {
        const upstream = await fetch('https://example.invalid/' + request.id);
        if (upstream.status >= 500) {
            // Plain Error: the upstream may well be back in five seconds.
            throw new Error(`upstream returned ${upstream.status}`);
        }
        return { url: await upstream.text() };
    }
}
