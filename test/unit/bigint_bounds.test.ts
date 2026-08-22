import { BigIntType, BIGINT_MAX, bytesToBigint } from '../../lib/custom_types';

describe('bigint decode bounds', () => {
    it('accepts the full 32-byte wire width', () => {
        const max = BigIntType.encode(BIGINT_MAX) as Uint8Array;
        expect(max).toHaveLength(32);
        expect(BigIntType.decode(Buffer.from(max))).toBe(BIGINT_MAX);
    });

    it('accepts a short encoding', () => {
        expect(BigIntType.decode(Buffer.from([0x01, 0x00]))).toBe(256n);
        expect(BigIntType.decode(Buffer.alloc(0))).toBe(0n);
    });

    it('rejects anything wider than the wire format instead of decoding it', () => {
        expect(() => BigIntType.decode(Buffer.alloc(33))).toThrow(RangeError);
        expect(() => bytesToBigint(Buffer.alloc(64 * 1024))).toThrow(RangeError);
    });

    it('cannot be made to spend unbounded CPU on one value', () => {
        const started = process.hrtime.bigint();
        expect(() => BigIntType.decode(Buffer.alloc(1024 * 1024, 0xff))).toThrow(RangeError);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        expect(ms).toBeLessThan(50);
    });
});
