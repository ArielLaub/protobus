import MessageFactory from '../../lib/message_factory';
import { BigIntType } from '../../lib/custom_types';

/**
 * Regression tests for the custom-type encode path.
 *
 * Two independent defects are covered here:
 *
 *  1. Nested custom types were silently encoded as zero. `messageNeedsPreprocess`
 *     only recursed when `field.resolvedType` was already populated, but
 *     protobufjs resolves lazily — so on the first call it was null, the
 *     message was reported as "no custom types", preprocessing was skipped,
 *     and the nested bigint/timestamp went out as an empty value. The result
 *     was then cached, making it permanent for the process.
 *
 *  2. BigIntType.encode took the absolute value and truncated mod 2^256,
 *     so -5n encoded identically to 5n and 2^256+7 became 7.
 */

const PROTO = `
syntax = "proto3";
package Fin;

message Money   { bigint amount = 1; string currency = 2; }
message Line    { Money price = 1; string sku = 2; }
message Order   { Line lines = 1; Money total = 2; timestamp placed_at = 3; }
message Deep    { Order order = 1; }
message TopUp   { bigint amount = 1; }
message Tree    { string v = 1; Tree child = 2; }

service Api {
  rpc topup  (TopUp) returns (TopUp);
  rpc money  (Money) returns (Money);
  rpc order  (Order) returns (Order);
  rpc deep   (Deep)  returns (Deep);
  rpc walk   (Tree)  returns (Tree);
}
`;

function newFactory(): MessageFactory {
    const f = new MessageFactory();
    f.init([]);
    f.parse(PROTO);
    return f;
}

function roundTrip(f: MessageFactory, method: string, payload: any): any {
    const buf = f.buildRequest(`Fin.Api.${method}`, payload, 'test-actor');
    return f.decodeRequest(buf).data;
}

describe('custom types at the top level', () => {
    it('round-trips a top-level bigint', () => {
        const out = roundTrip(newFactory(), 'topup', { amount: 42n });
        expect(out.amount).toBe(42n);
    });
});

describe('custom types nested inside a sub-message', () => {
    it('round-trips a bigint one level deep', () => {
        const out = roundTrip(newFactory(), 'order', {
            total: { amount: 1234567890123456789n, currency: 'USD' },
        });
        expect(out.total.amount).toBe(1234567890123456789n);
    });

    it('round-trips a bigint two levels deep', () => {
        const out = roundTrip(newFactory(), 'order', {
            lines: { price: { amount: 999n, currency: 'USD' }, sku: 'ABC' },
        });
        expect(out.lines.price.amount).toBe(999n);
    });

    it('round-trips a bigint three levels deep', () => {
        const out = roundTrip(newFactory(), 'deep', {
            order: { total: { amount: 7n, currency: 'EUR' } },
        });
        expect(out.order.total.amount).toBe(7n);
    });

    it('round-trips a nested timestamp', () => {
        const when = new Date('2026-08-03T10:00:00.000Z');
        const out = roundTrip(newFactory(), 'order', { placed_at: when });
        expect(out.placed_at).toBeInstanceOf(Date);
        expect((out.placed_at as Date).getTime()).toBe(when.getTime());
    });

    it('does not corrupt a nested bigint when an unrelated type is encoded first', () => {
        // Encoding a message with no custom types must not poison the cache
        // for a later message that does have them.
        const f = newFactory();
        roundTrip(f, 'walk', { v: 'x' });
        const out = roundTrip(f, 'order', { total: { amount: 555n, currency: 'GBP' } });
        expect(out.total.amount).toBe(555n);
    });
});

describe('recursive (self-referential) message types', () => {
    it('encodes a self-referential message without overflowing the stack', () => {
        const f = newFactory();
        // Force protobufjs to resolve every field up front, which is what
        // loadSync() does for on-disk protos.
        (f.root as any).resolveAll();
        expect(() => roundTrip(f, 'walk', { v: 'x' })).not.toThrow();
    });

    it('still encodes nested custom types after a full resolve', () => {
        const f = newFactory();
        (f.root as any).resolveAll();
        const out = roundTrip(f, 'order', { total: { amount: 88n, currency: 'USD' } });
        expect(out.total.amount).toBe(88n);
    });
});

describe('preprocess decisions are per-factory, not global', () => {
    it('does not share cached decisions between two factories', () => {
        const a = newFactory();
        roundTrip(a, 'order', { total: { amount: 1n, currency: 'USD' } });

        const b = newFactory();
        const out = roundTrip(b, 'order', { total: { amount: 2n, currency: 'USD' } });
        expect(out.total.amount).toBe(2n);
    });
});

describe('BigIntType range validation', () => {
    it('encodes the full unsigned 256-bit range', () => {
        const max = 2n ** 256n - 1n;
        expect(BigIntType.decode(BigIntType.encode(max))).toBe(max);
        expect(BigIntType.decode(BigIntType.encode(0n))).toBe(0n);
    });

    it('rejects negative values instead of silently dropping the sign', () => {
        expect(() => BigIntType.encode(-5n)).toThrow(RangeError);
        expect(() => BigIntType.encode('-1')).toThrow(RangeError);
    });

    it('rejects values that do not fit in 256 bits instead of truncating', () => {
        expect(() => BigIntType.encode(2n ** 256n)).toThrow(RangeError);
        expect(() => BigIntType.encode(2n ** 256n + 7n)).toThrow(RangeError);
    });

    it('surfaces out-of-range values through the message encode path', () => {
        const f = newFactory();
        expect(() => roundTrip(f, 'topup', { amount: -1n })).toThrow(RangeError);
    });
});
