import * as protoBuf from 'protobufjs';
import MessageFactory from '../../lib/message_factory';

/**
 * protobufjs keeps two pieces of parser state on the `parse` function itself:
 * `parse.defaults`, the options used when a caller passes none, and
 * `parse.filename`, the name reported in "(<filename>, line n)" syntax errors.
 * Both are module-level and shared by every consumer of protobufjs in the
 * process — an application that embeds protobus and also uses protobufjs
 * directly gets whatever protobus left there.
 *
 * So the factory must borrow that state, never keep it: parse options are
 * passed per call, and the filename is put back after each parse, including
 * when the parse throws.
 */

const parser = protoBuf.parse as any;

const PROTO = `syntax = "proto3";
package Iso;

message PlayerJoined {
    string player_id = 1;
}

service Player {
    rpc join (Iso.PlayerJoined) returns (Iso.PlayerJoined);
}`;

const CONFLICTING = `syntax = "proto3";
package Iso;

message PlayerJoined {
    int32 completely_different = 1;
}`;

const MALFORMED = `syntax = "proto3";
package Iso;

message @@@ {
}`;

describe('protobufjs global state isolation', () => {
    it('leaves parse.defaults at protobufjs\'s own values', () => {
        // Importing the factory must not have rewritten them, and neither must
        // parsing through it.
        expect(parser.defaults).toEqual({ keepCase: false });

        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'Iso.Player.p1');

        expect(parser.defaults).toEqual({ keepCase: false });
    });

    it('keeps field casing without relying on the global default', () => {
        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'Iso.Player.p1');

        // `player_id`, not `playerId` — camel-casing the name would change the
        // shape of every decoded message.
        expect(Object.keys(factory.root.lookupType('Iso.PlayerJoined').fields)).toEqual(['player_id']);
    });

    it('leaves parse.filename unset after a successful parse', () => {
        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'Iso.Player.p1');

        expect(parser.filename).toBeNull();
    });

    it('leaves parse.filename unset after a parse that throws', () => {
        const factory = new MessageFactory();
        factory.init([]);
        factory.parse(PROTO, 'Iso.Player.p1');

        // A duplicate-name rejection escapes protobufjs's own cleanup, so the
        // module name would otherwise stay behind and label the next
        // unrelated parse error as coming from this schema.
        expect(() => factory.parse(CONFLICTING, 'Iso.Other')).toThrow();
        expect(parser.filename).toBeNull();
    });

    it('still names the module in a syntax error', () => {
        const factory = new MessageFactory();
        factory.init([]);

        expect(() => factory.parse(MALFORMED, 'Iso.Malformed')).toThrow(/Iso\.Malformed/);
        expect(parser.filename).toBeNull();
    });
});
