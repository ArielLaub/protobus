import { Log } from 'protobus';

export function recordPublish(correlationId: string, content: Buffer, decoded: unknown): void {
    Log.info('published request', {
        operation: 'publish',
        messageType: 'example.Service.DoThing',
        correlationId,
        sizeBytes: content.length,
        outcome: 'confirmed',
        diagnostics: () => ({ payload: decoded }),   // read only if a serializer is installed
    });
}
