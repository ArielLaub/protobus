import MessageFactory, { NotInitializedError } from '../../lib/message_factory';

const proto = `syntax = "proto3";
package Silent;

message Request { string a = 1; }
message Response { string b = 1; }

service Service {
    rpc go(Silent.Request) returns(Silent.Response);
}`;

/**
 * `parse()` before `init()` has to fail, because it cannot succeed.
 *
 * `init()` is what creates `this.root`. Called before it, `parse()` handed
 * protobufjs an undefined root, protobufjs quietly made one of its own, and
 * the parsed schema went into that and was dropped on return. The call
 * returned normally, so the schema simply was not there later — surfacing much
 * further away as `no such Service` or `MissingProto`, in code that had
 * demonstrably registered it.
 */
describe('MessageFactory.parse before init', () => {
    it('throws NotInitializedError rather than parsing into a discarded root', () => {
        const factory = new MessageFactory();
        expect(() => factory.parse(proto, 'Silent.Service')).toThrow(NotInitializedError);
    });

    it('names the ordering in the message, since that is the whole fix', () => {
        const factory = new MessageFactory();
        expect(() => factory.parse(proto, 'Silent.Service')).toThrow(/init/i);
    });

    it('is why the schema was missing afterwards', () => {
        // The behaviour the throw replaces, kept as the reason it exists: a
        // schema parsed before init() is nowhere to be found once init() runs.
        const factory = new MessageFactory();
        try {
            factory.parse(proto, 'Silent.Service');
        } catch {
            // expected now; was silent before
        }
        factory.init([]);
        expect(factory.hasService('Silent.Service')).toBe(false);
    });

    it('works in the supported order', () => {
        const factory = new MessageFactory();
        factory.init([]);
        expect(() => factory.parse(proto, 'Silent.Service')).not.toThrow();
        expect(factory.hasService('Silent.Service')).toBe(true);
    });
});
