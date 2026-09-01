import { StreamingError, StreamTimeoutError, StreamBackpressureError, StreamSequenceError, DisconnectedError } from 'protobus';

async function drain(chunks: AsyncIterable<{ text: string }>): Promise<string> {
    let out = '';
    try {
        for await (const chunk of chunks) out += chunk.text;
    } catch (error) {
        if (error instanceof StreamSequenceError) throw error;        // data is incomplete; do not use `out`
        if (error instanceof StreamTimeoutError) return out;          // producer stalled; partial is acceptable here
        if (error instanceof StreamBackpressureError) throw error;    // we are too slow; fix the consumer
        if (error instanceof DisconnectedError) throw error;          // the socket went, not the stream
        if (error instanceof StreamingError) throw error;
        throw error;
    }
    return out;
}
