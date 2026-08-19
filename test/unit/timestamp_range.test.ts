import { TimestampType } from '../../lib/custom_types';

/** How protobufjs surfaces an int64 when Long support is absent. */
function asLong(ms: number) {
    return { low: ms | 0, high: Math.floor(ms / 0x100000000) | 0 };
}

describe('timestamp decode range', () => {
    const cases: Array<[string, string]> = [
        ['pre-epoch', '1960-01-01T00:00:00.000Z'],
        ['the epoch', '1970-01-01T00:00:00.000Z'],
        ['just before the epoch', '1969-12-31T23:59:59.999Z'],
        ['post-2038', '2100-06-15T12:34:56.789Z'],
    ];

    it.each(cases)('round-trips %s through the Long path', (_name, iso) => {
        const date = new Date(iso);
        const ms = TimestampType.encode(date) as number;
        expect(TimestampType.decode(asLong(ms)).toISOString()).toBe(iso);
    });

    it.each(cases)('round-trips %s through the plain-number path', (_name, iso) => {
        const date = new Date(iso);
        expect(TimestampType.decode(TimestampType.encode(date) as number).toISOString()).toBe(iso);
    });
});
