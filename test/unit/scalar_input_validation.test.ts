import { BigIntType, TimestampType } from '../../lib/custom_types';

/**
 * The built-in scalars must refuse input they cannot represent rather than
 * encode it as something else (#25). A timestamp that is NaN goes out as 0 —
 * 1970, indistinguishable from an instant someone meant — and a JavaScript
 * number above 2^53-1 has already lost precision before `bigint` sees it.
 */

describe('TimestampType.encode refuses what it cannot represent', () => {
    it.each([
        ['an invalid Date', new Date('nonsense')],
        ['an unparseable string', 'not-a-date'],
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['a fractional millisecond', 1.5],
        ['a number beyond the Date range', 8.64e15 + 1],
    ])('rejects %s', (_label, value) => {
        expect(() => TimestampType.encode(value as any)).toThrow(RangeError);
    });

    it('names what to pass instead', () => {
        expect(() => TimestampType.encode('not-a-date')).toThrow(/Date|milliseconds/);
    });

    it.each([
        ['a Date', new Date('2020-01-01T00:00:00.000Z'), 1577836800000],
        ['an ISO string', '2020-01-01T00:00:00.000Z', 1577836800000],
        ['integer milliseconds', 1577836800000, 1577836800000],
        ['a pre-1970 instant', -14182940000, -14182940000],
        ['the epoch', 0, 0],
    ])('still accepts %s', (_label, value, want) => {
        expect(TimestampType.encode(value as any)).toBe(want);
    });
});

describe('BigIntType.encode refuses a number that has lost precision', () => {
    it('rejects a number above Number.MAX_SAFE_INTEGER', () => {
        // The literal is already 9007199254740992 by the time encode sees it.
        // eslint-disable-next-line no-loss-of-precision
        expect(() => BigIntType.encode(9007199254740993)).toThrow(RangeError);
        expect(() => BigIntType.encode(2 ** 60)).toThrow(/bigint|string/);
    });

    it.each([
        ['a safe integer number', Number.MAX_SAFE_INTEGER],
        ['zero', 0],
        ['a bigint beyond 2^53', 9007199254740993n],
        ['a decimal string beyond 2^53', '9007199254740993'],
    ])('still accepts %s', (_label, value) => {
        expect(() => BigIntType.encode(value as any)).not.toThrow();
    });

    it('round-trips a bigint beyond 2^53 exactly', () => {
        expect(BigIntType.decode(BigIntType.encode(9007199254740993n) as Uint8Array)).toBe(9007199254740993n);
    });
});
