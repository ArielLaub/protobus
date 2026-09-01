import { setDiagnosticsSerializer } from 'protobus';

// Log field names only, never values.
setDiagnosticsSerializer((diagnostics) => {
    const payload = (diagnostics as { payload?: unknown }).payload;
    if (!payload || typeof payload !== 'object') { return undefined; }
    return { fields: Object.keys(payload as object) };
});
