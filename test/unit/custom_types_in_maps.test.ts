import MessageFactory from '../../lib/message_factory';

/**
 * Encode preprocessing walks a message converting custom-type values to their
 * wire form. A map field is neither a scalar nor a repeated field: it arrives
 * as an object whose *values* need converting, and handing the whole object to
 * the codec fails on the first one.
 */
describe('custom types inside map fields', () => {
    const factory = new MessageFactory();

    beforeAll(() => {
        factory.init([]);
        factory.parse(`syntax="proto3"; package Maps;
            message Holder { bigint amount = 1; }
            message Req {
                map<string, bigint> values = 1;
                map<int32, bigint> by_index = 2;
                map<string, Holder> holders = 3;
                map<string, string> labels = 4;
                bigint total = 5;
                repeated bigint history = 6;
            }
            service Calc { rpc add(Maps.Req) returns(Maps.Req); }`);
    });

    const roundTrip = (obj: any) =>
        factory.decodeRequest(factory.buildRequest('Maps.Calc.add', obj, 'test')).data as any;

    it('converts each value of a custom-type map', () => {
        const out = roundTrip({ values: { x: 42n, y: 7n } });
        expect(out.values).toEqual({ x: 42n, y: 7n });
    });

    it('preserves keys, including numeric ones', () => {
        const out = roundTrip({ by_index: { 1: 10n, 2: 20n } });
        expect(Object.keys(out.by_index).sort()).toEqual(['1', '2']);
        expect(out.by_index['1']).toBe(10n);
    });

    it('converts custom fields of messages held in a map', () => {
        const out = roundTrip({ holders: { a: { amount: 5n }, b: { amount: 6n } } });
        expect(out.holders.a.amount).toBe(5n);
        expect(out.holders.b.amount).toBe(6n);
    });

    it('leaves a plain map alone', () => {
        const out = roundTrip({ labels: { a: 'one' }, total: 1n });
        expect(out.labels).toEqual({ a: 'one' });
    });

    it('round-trips an empty map', () => {
        const out = roundTrip({ values: {}, total: 1n });
        expect(out.values).toEqual({});
    });

    it('keeps scalar and repeated custom-type fields working', () => {
        const out = roundTrip({ total: 99n, history: [1n, 2n, 3n] });
        expect(out.total).toBe(99n);
        expect(out.history).toEqual([1n, 2n, 3n]);
    });

    it('carries a large value through a map without loss', () => {
        const big = 2n ** 200n + 12345n;
        expect(roundTrip({ values: { big } }).values.big).toBe(big);
    });
});
