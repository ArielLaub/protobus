import { setDiagnosticsSerializer } from 'protobus';

setDiagnosticsSerializer((diagnostics, record) => {
    // Full payloads for one operation, in one environment, and nothing else.
    if (process.env.NODE_ENV === 'production') { return undefined; }
    if (record.operation !== 'consume') { return undefined; }
    return { payload: (diagnostics as { payload?: unknown }).payload };
});

setDiagnosticsSerializer(null);   // back off; nothing is assembled again
