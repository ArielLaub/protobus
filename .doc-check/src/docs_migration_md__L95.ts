
// Decoded shape of: message ReplayRequest { int32 fromIndex = 1; string cursor = 2; }
interface ReplayRequest { fromIndex?: number; cursor?: string }

// BEFORE — written against 1.x, where an unsent fromIndex arrived as undefined.
function startIndexOld(request: ReplayRequest): number {
    // 1.x: unsent -> undefined -> falls back to 100.
    // 2.x: unsent -> 0         -> returns 0 and replays the whole log.
    return request.fromIndex ?? 100;
}

// AFTER — proto3 has no field presence for scalars, so "unset" is not a
// question the wire can answer. Decide what zero means and say so.
function startIndexNew(request: ReplayRequest): number {
    return request.fromIndex && request.fromIndex > 0 ? request.fromIndex : 100;
}
