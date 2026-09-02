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

    it('leaves the factory untouched, rather than half-registering the schema', () => {
        // The throw must happen BEFORE any bookkeeping, or a caller who
        // catches it is left with a factory that believes it holds a schema
        // its root has never seen — the same map-versus-root divergence the
        // built-in types suffered.
        const factory = new MessageFactory();
        expect(() => factory.parse(proto, 'Silent.Service')).toThrow(NotInitializedError);

        factory.init([]);
        expect(factory.hasService('Silent.Service')).toBe(false);

        // And re-parsing in the right order still works: the failed attempt
        // must not have memoised the schema text as already registered.
        factory.parse(proto, 'Silent.Service');
        expect(factory.hasService('Silent.Service')).toBe(true);
    });

    it('works in the supported order', () => {
        const factory = new MessageFactory();
        factory.init([]);
        expect(() => factory.parse(proto, 'Silent.Service')).not.toThrow();
        expect(factory.hasService('Silent.Service')).toBe(true);
    });
});
