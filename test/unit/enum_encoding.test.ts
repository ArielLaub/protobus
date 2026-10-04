import MessageFactory from '../../lib/message_factory';

/**
 * Decoding hands an enum back as its value NAME (`enums: String`), so a name
 * is what callers hold, and what they pass back when they relay or echo a
 * message. Encoding must accept it: protobufjs `create()` copies a name as-is
 * and the encoder then writes 0, silently turning every enum into its first
 * value. Numbers must keep working too. (#40)
 */

const PROTO = `syntax = "proto3";
package Shop;

enum Status { PENDING = 0; SHIPPED = 1; DELIVERED = 2; }

message Order {
    string id = 1;
    Status status = 2;
    repeated Status history = 3;
    map<string, Status> by_region = 4;
    bigint amount = 5;
}

service Orders {
    rpc update (Shop.Order) returns (Shop.Order);
}`;

function factory(): MessageFactory {
    const f = new MessageFactory();
    f.init([]);
    f.parse(PROTO, 'Shop.Orders');
    return f;
}

const viaRequest = (f: MessageFactory, obj: any) =>
    f.decodeRequest(f.buildRequest('Shop.Orders.update', obj, 'tester')).data;
const viaResponse = (f: MessageFactory, obj: any) =>
    (f.decodeResponse(f.buildResponse('Shop.Orders.update', obj)).result as any).data;
const viaEvent = (f: MessageFactory, obj: any) =>
    f.decodeEvent(f.buildEvent('Shop.Order', obj, 'EVENT.Shop.Order')).data;

describe.each([
    ['request', viaRequest],
    ['response', viaResponse],
    ['event', viaEvent],
])('enums in a %s', (_kind, roundTrip) => {
    it('encodes an enum given by name', () => {
        const out = roundTrip(factory(), { id: 'o1', status: 'DELIVERED' });
        expect(out.status).toBe('DELIVERED');
    });

    it('still encodes an enum given by number', () => {
        const out = roundTrip(factory(), { id: 'o1', status: 1 });
        expect(out.status).toBe('SHIPPED');
    });

    it('encodes repeated and map enums given by name', () => {
        const out = roundTrip(factory(), { id: 'o1', history: ['SHIPPED', 'DELIVERED'], by_region: { eu: 'SHIPPED' } });
        expect(out.history).toEqual(['SHIPPED', 'DELIVERED']);
        expect(out.by_region).toEqual({ eu: 'SHIPPED' });
    });

    it('re-sends a decoded message unchanged, custom types included', () => {
        const f = factory();
        const first = roundTrip(f, { id: 'o1', status: 2, history: [1], by_region: { eu: 2 }, amount: 12345678901234567890n });
        const relayed = roundTrip(f, first);
        expect(relayed).toEqual(first);
        expect(relayed.status).toBe('DELIVERED');
        expect(relayed.amount).toBe(12345678901234567890n);
    });
});
