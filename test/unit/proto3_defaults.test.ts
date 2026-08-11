import MessageFactory from '../../lib/message_factory';

/**
 * proto3 has no field presence for scalars: a field equal to its default (0,
 * "", false) is not written to the wire at all. Decoding must therefore supply
 * the default, or every zero value comes back as `undefined` and the caller
 * cannot tell "zero" from "absent" — for proto3 scalars there is no difference.
 *
 * The combat-game sample turns on this: a turn index of 0 is a perfectly
 * ordinary value, and losing it stalls the game the moment play wraps back to
 * the first player.
 */

const PROTO = `syntax = "proto3";
package T;

message Turn {
    int32 next_index = 1;
    string label = 2;
    bool active = 3;
    double ratio = 4;
    repeated int32 tags = 5;
}

message Res { bool ok = 1; }

service Api {
    rpc play (T.Turn) returns (T.Res);
}`;

function factory(): MessageFactory {
    const f = new MessageFactory();
    f.init([]);
    f.parse(PROTO, 'T.Api');
    return f;
}

function roundTrip(f: MessageFactory, obj: any): any {
    const buf = f.buildRequest('T.Api.play', obj, 'tester');
    return f.decodeRequest(buf).data;
}

describe('proto3 default values survive a round trip', () => {
    it('keeps a zero integer as 0, not undefined', () => {
        const out = roundTrip(factory(), { next_index: 0, label: 'x' });
        expect(out.next_index).toBe(0);
    });

    it('keeps non-zero integers intact', () => {
        const out = roundTrip(factory(), { next_index: 4, label: 'x' });
        expect(out.next_index).toBe(4);
    });

    it('keeps an empty string and a false boolean', () => {
        const out = roundTrip(factory(), { next_index: 1, label: '', active: false });
        expect(out.label).toBe('');
        expect(out.active).toBe(false);
    });

    it('keeps a zero double', () => {
        const out = roundTrip(factory(), { next_index: 1, ratio: 0 });
        expect(out.ratio).toBe(0);
    });

    it('gives an unset repeated field an empty array', () => {
        const out = roundTrip(factory(), { next_index: 1 });
        expect(out.tags).toEqual([]);
    });

    it('supplies defaults for fields the sender omitted entirely', () => {
        // Indistinguishable on the wire from explicitly-zero, and must decode
        // the same way.
        const out = roundTrip(factory(), { label: 'only this' });
        expect(out.next_index).toBe(0);
        expect(out.active).toBe(false);
    });
});
